// Vijuga realtime server: rooms with presence, direct messages and per-host match channels.
// A drop-in replacement for the Supabase Realtime layer, without rate limits or dropped channels.
//   client -> server:  {t:'hi', room, peer, k?}         join a room with my peer id (k: my secret for that id, see below)
//                      {t:'pres', patch}               presence patch -> everyone in the room
//                      {t:'own', patch}                match state -> everyone who follows me (and me as host: nobody)
//                      {t:'to', peer, patch}           direct (inputs to the host, visibility)
//                      {t:'follow', peer|null}         receive that host's match channel
//                      {t:'ping', n}                   keepalive / latency
//   server -> client:  {t:'hello', peer, now}          joined; followed by a full 'peers' sync
//                      {t:'peers', peers:[{peer, presence}]}
//                      {t:'p', peer, patch}            a peer's patch (presence, own or direct)
//                      {t:'bye', peer}                 a peer left
//                      {t:'pong', n, now}
//                      {t:'err', e}                    'bad hi' | 'bad k' | 'taken': the hi was refused (socket closed);
//                                                      'big' | 'full' | 'rate' | 'key': one message was dropped
//
// Peer ids are public (everyone in the room and /peers sees them), so an id alone must not let a stranger take over a
// player or a host. A client proves it owns its id with k: a random secret (at least 128 bits, 32-128 characters of
// [A-Za-z0-9_-]) it makes together with the id and sends in every hi for that id. The first hi with a k binds the id to
// it; while that connection lives, and for KEY_GRACE_MS after it closes, a hi for the same id is accepted only with the
// same k (the owner's reconnect still replaces its old socket at once). A hi without k for an id nobody has bound
// behaves as before, so clients without k keep working (they just are not protected).
//
// Abuse limits. Legitimate traffic measured in the relay during the multi-browser suites (24 online scenarios with 2-8
// players, host migration, spectators, rematches; plus the trail-history and voice tests): a host sends <= 19 messages
// and <= 24 kB in any second (~12 kB/s on average); one snapshot ('own') is <= 2.2 kB (6 players); a peer's whole stored
// presence is <= 0.3 kB (17 keys); one 'pres' message without voice is <= 0.2 kB; a 5 s voice clip is 13 kB (Chromium,
// 16 kbit/s); a late arrival's trail history ('th') was 14 kB after a 28 s round (its cap: ~870 kB for 8 snakes at 6000
// vertices each). Every limit below has at least x4 headroom over the measured values; going over one drops that
// message (the sender gets {t:'err'}), and only sustained abuse (more than ABUSE_CLOSE dropped messages within about
// ABUSE_DECAY_MS) closes the socket.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const ROOM_RE = /^vijuga-lobby(-[a-z0-9-]{1,24})?$/, PEER_RE = /^[a-z0-9]{4,16}$/, KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/; // a stored presence key ('__proto__' and friends never become one)
const MAX_MSG = 1_000_000; // bytes, hard frame limit (ws closes the socket above it): a late arrival's trail history ('th') in a very long 8-player round reaches ~870 kB
const TRANSIENT = new Set(["msg", "re", "ping", "pong", "dm", "bt"]); // relayed, never kept in presence
const IDENTITY = ["sl", "nm", "st", "hs", "pls", "pmid", "cl"]; // a direct message may not forge who the sender is or what match they host
const PRES_MAX = 8_000; // bytes, a peer's whole stored presence (legit <= 0.3 kB: lobby flags, name, badges, seats; x30)
const TRANSIENT_MAX = 4_000; // bytes, the one-off part of a patch (chat line <= 80 chars, reaction, ping, dm, bounty) without the voice clip (legit <= ~0.4 kB; x10)
const VOICE_MAX = 128_000; // characters of the voice clip's data URL (msg[3]); 13 kB measured (x10), and 5 s still fit at a browser's default 128 kbit/s
const OWN_MAX = 200_000; // bytes, one match snapshot (legit <= 2.2 kB)
const RATE_BURST = 600, RATE_PER_SEC = 200; // messages, per connection (legit <= 19 a second; x10)
const BYTES_BURST = 4_000_000, BYTES_PER_SEC = 256_000; // bytes, everything a connection sends (legit <= 24 kB in any second, x10; the burst holds six trail histories at their cap)
const ROOM_BURST = 600_000, ROOM_PER_SEC = 32_000; // bytes of presence/chat a connection sends to the whole room (legit: ~0.1 kB/s plus a 13 kB clip now and then)
const SEND_SOFT = 1_000_000; // bytes queued for a receiver: above this it gets no presence or chat until it drains (then the whole room again, in one piece); snapshots already stop at 64 kB
const SEND_HARD = 4_000_000; // ... and a receiver above this at two heartbeats in a row (6-12 s) is dropped
const ABUSE_CLOSE = 50, ABUSE_DECAY_MS = 10_000; // dropped messages (decaying) before the socket is closed
const KEY_GRACE_MS = Number(process.env.VIJUGA_KEY_GRACE_MS) || 5 * 60_000; // how long an id stays bound to its k after its socket closed (env: tests only)
const KEY_MAX = 50_000; // most id bindings kept (live ones always are)
const SYNC_GAP_MS = 250; // join/leave storms are folded into one full room sync per this gap

/** @typedef {{ws: import('ws').WebSocket, presence: Record<string, unknown>, sizes: Record<string, number>, presSize: number, following: string|null, stale: boolean}} Member */
/** @type {Map<string, Map<string, Member> & {syncAt?: number, syncT?: NodeJS.Timeout|null}>} */
const rooms = new Map();
/** @type {Map<string, {h: Buffer, ws: import('ws').WebSocket|null, until: number}>} room/peer -> sha256(k), live socket, end of grace */
const keys = new Map();
let msgCount = 0, dropped = 0, refused = 0, closedForAbuse = 0;

const server = http.createServer((req, res) => {
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); res.end(); return; } // a malformed request must not take the relay down
  if (url.pathname === "/peers") { // who is in a room (for the stats page); only lobby fields
    const room = rooms.get(String(url.searchParams.get("room") || ""));
    const keep = ["nm", "sl", "cl", "rd", "hs", "ig", "pl", "watch", "pg", "obs"];
    const peers = room ? [...room.entries()].map(([peer, m]) => ({ peer, presence: Object.fromEntries(keep.filter((k) => k in m.presence).map((k) => [k, m.presence[k]])) })) : [];
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ peers })); return;
  }
  const stats = { ok: true, rooms: rooms.size, peers: [...rooms.values()].reduce((s, r) => s + r.size, 0), msgs: msgCount, dropped, refused, closedForAbuse, up: Math.round(process.uptime()) };
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(JSON.stringify(stats));
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

const sendRaw = (ws, s) => { if (ws.readyState === 1) { try { ws.send(s); } catch {} } };
const send = (ws, obj) => sendRaw(ws, JSON.stringify(obj));
const backedUp = (ws) => ws.bufferedAmount > SEND_SOFT;
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v));
const keyHash = (k) => crypto.createHash("sha256").update(k).digest();
const bucket = (rate, burst) => ({ rate, burst, tokens: burst, at: Date.now() });
const take = (b, n, now) => { b.tokens = Math.min(b.burst, b.tokens + (now - b.at) / 1000 * b.rate); b.at = now; if (b.tokens < n) return false; b.tokens -= n; return true; };
// at most 5 warning lines a second, so an attack cannot flood the logs
let warnAt = 0, warnN = 0, warnHidden = 0;
const warn = (s) => { const now = Date.now(); if (now - warnAt >= 1000) { warnAt = now; warnN = 0; } if (++warnN > 5) { warnHidden++; return; } console.warn(warnHidden ? `${s} (+${warnHidden} lines suppressed)` : s); warnHidden = 0; };
const roomOf = (name) => { let r = rooms.get(name); if (!r) { r = new Map(); rooms.set(name, r); } return r; };
const peersMsg = (room) => JSON.stringify({ t: "peers", peers: [...room.entries()].map(([peer, m]) => ({ peer, presence: m.presence })) });
const syncOne = (m, s) => { m.stale = false; sendRaw(m.ws, s); };
// a receiver whose connection is backed up is skipped and marked stale: it gets the whole room once it drains
const syncAll = (room) => { const s = peersMsg(room); for (const m of room.values()) { if (backedUp(m.ws)) m.stale = true; else syncOne(m, s); } };
// every join/leave sends the whole room to everyone; a storm of them is folded into one sync per SYNC_GAP_MS
// (a newcomer always gets the room at once)
const syncPeers = (name, room, newcomer) => {
  const now = Date.now();
  if (!room.syncT && now - (room.syncAt || 0) >= SYNC_GAP_MS) { room.syncAt = now; syncAll(room); return; }
  if (newcomer) syncOne(newcomer, peersMsg(room));
  if (!room.syncT) room.syncT = setTimeout(() => { room.syncT = null; room.syncAt = Date.now(); if (rooms.get(name) === room && room.size) syncAll(room); }, Math.max(0, SYNC_GAP_MS - (now - room.syncAt)));
};
// bindings of closed sockets expire after the grace period; under a flood of ids the oldest ones in grace go first
const pruneKeys = (now, force) => {
  if (!force && keys.size <= KEY_MAX) return;
  for (const [id, b] of keys) if (!b.ws && b.until <= now) keys.delete(id);
  if (keys.size > KEY_MAX) for (const [id, b] of keys) { if (keys.size <= KEY_MAX * 0.9) break; if (!b.ws) keys.delete(id); }
};

wss.on("connection", (ws, req) => {
  let roomName = null, peer = null, keyId = null;
  const from = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const msgs = bucket(RATE_PER_SEC, RATE_BURST), bytes = bucket(BYTES_PER_SEC, BYTES_BURST), roomBytes = bucket(ROOM_PER_SEC, ROOM_BURST);
  let abuse = 0, abuseAt = 0, errAt = 0; const logged = new Set();
  // an over-limit message is dropped and the sender told (at most once a second); only sustained abuse closes the socket
  const strike = (why) => {
    const now = Date.now(); dropped++;
    abuse = abuse * Math.exp((abuseAt - now) / ABUSE_DECAY_MS) + 1; abuseAt = now;
    if (now - errAt >= 1000) { errAt = now; send(ws, { t: "err", e: why }); }
    if (!logged.has(why)) { logged.add(why); warn(`dropped (${why}) from ${roomName || "-"}/${peer || "-"} ${from}`); }
    if (abuse > ABUSE_CLOSE && ws.readyState === 1) { closedForAbuse++; warn(`closed ${roomName || "-"}/${peer || "-"} ${from}: sustained abuse (${[...logged].join(",")})`); ws.close(4008, "limits"); }
  };
  ws.on("message", (buf) => {
    if (ws.readyState !== 1) return; // closing (refused or abusive): nothing more is relayed
    const now = Date.now();
    if (!take(msgs, 1, now) || !take(bytes, buf.length, now)) { strike("rate"); return; } // flooding peers are throttled, not relayed
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== "object") return;
    msgCount++;
    if (m.t === "hi") {
      if (roomName) return;
      if (!ROOM_RE.test(String(m.room)) || !PEER_RE.test(String(m.peer))) { send(ws, { t: "err", e: "bad hi" }); ws.close(); return; }
      if (m.k !== undefined && (typeof m.k !== "string" || !KEY_RE.test(m.k))) { send(ws, { t: "err", e: "bad k" }); ws.close(); return; }
      const id = m.room + "/" + m.peer, b = keys.get(id), h = m.k !== undefined ? keyHash(m.k) : null;
      if (b && (b.ws || b.until > now) && !(h && crypto.timingSafeEqual(h, b.h))) {
        // the id belongs to someone else (connected, or reconnecting within the grace period): refuse, the owner stays
        refused++; warn(`refused hi for ${id} from ${from}: ${h ? "wrong" : "no"} k`);
        send(ws, { t: "err", e: "taken" }); ws.close(4003, "taken"); return;
      }
      if (h) { keys.delete(id); keys.set(id, { h, ws, until: 0 }); keyId = id; pruneKeys(now, false); }
      else if (b) keys.delete(id); // an expired binding: the id is free again
      // The newest connection of a peer id (with its k, if it has one) always wins, at once. A phone that comes back from
      // the background often opens its new socket while the old one still looks alive; making the newcomer wait (or
      // refusing it) left a "zombie" entry in the room: a phantom host nobody could join, a player whose inputs never
      // arrived, a ready flag that never changed.
      const room = roomOf(m.room);
      const old = room.get(m.peer);
      if (old && old.ws !== ws) { try { old.ws.close(); } catch {} }
      roomName = m.room; peer = m.peer;
      const me = { ws, presence: old ? old.presence : {}, sizes: old ? old.sizes : {}, presSize: old ? old.presSize : 0, following: null, stale: false };
      room.set(peer, me);
      send(ws, { t: "hello", peer, now: Date.now() });
      syncPeers(roomName, room, me);
      return;
    }
    if (!roomName) return;
    const room = rooms.get(roomName); const me = room && room.get(peer); if (!me || me.ws !== ws) return;
    if (m.t === "ping") { send(ws, { t: "pong", n: m.n, now: Date.now() }); return; }
    if (m.t === "pres" && m.patch && typeof m.patch === "object" && !Array.isArray(m.patch)) {
      // what the patch costs: its one-off part (chat, voice) and how much it grows my stored presence
      let oneOff = 0, voice = 0, grow = 0; const sizes = {};
      for (const k in m.patch) {
        const v = m.patch[k];
        if (TRANSIENT.has(k)) {
          if (k === "msg" && Array.isArray(v) && typeof v[3] === "string" && v[3].startsWith("data:audio/")) { voice = v[3].length; oneOff += jsonBytes(v) - voice; }
          else oneOff += jsonBytes(v);
          continue;
        }
        if (!NAME_RE.test(k)) { strike("key"); return; }
        const n = v === null ? 0 : k.length + 4 + jsonBytes(v);
        sizes[k] = n; grow += n - (me.sizes[k] || 0);
      }
      if (oneOff > TRANSIENT_MAX || voice > VOICE_MAX) { strike("big"); return; }
      if (me.presSize + grow > PRES_MAX) { strike("full"); return; } // the patch would make my presence too big: dropped whole
      if (!take(roomBytes, buf.length, now)) { strike("rate"); return; } // everyone in the room receives it
      const keeps = Object.keys(sizes).length > 0;
      for (const k in sizes) { if (sizes[k]) { me.presence[k] = m.patch[k]; me.sizes[k] = sizes[k]; } else { delete me.presence[k]; delete me.sizes[k]; } }
      me.presSize += grow;
      // the same account on a new connection (reload, network change, second tab): the old connection is a ghost -> drop it
      // at once. The game relies on one live connection per account; two of them made lobby flags (ready, host) ambiguous.
      const sl = typeof m.patch.sl === "string" ? m.patch.sl : null;
      if (sl && me.presence.pg !== "stats" && !me.presence.obs) {
        for (const [k, o] of [...room]) if (k !== peer && o.presence.sl === sl && o.presence.pg !== "stats" && !o.presence.obs) { send(o.ws, { t: "replaced" }); setTimeout(() => { try { o.ws.close(4001, "replaced"); } catch {} }, 50); room.delete(k); for (const q of room.values()) send(q.ws, { t: "bye", peer: k }); }
      }
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      for (const [k, o] of room) {
        if (k === peer || o.ws.readyState !== 1) continue;
        if (backedUp(o.ws)) { if (keeps) o.stale = true; continue; } // a chat line is lost; presence comes back with the next full sync
        if (o.stale) syncOne(o, peersMsg(room));
        sendRaw(o.ws, out);
      }
      return;
    }
    if (m.t === "own" && m.patch && typeof m.patch === "object") {
      if (buf.length > OWN_MAX) { strike("big"); return; }
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      // a follower whose connection is backed up gets the next snapshot instead of a growing queue
      for (const [k, o] of room) if (k !== peer && o.following === peer && o.ws.readyState === 1 && o.ws.bufferedAmount < 65536) sendRaw(o.ws, out);
      return;
    }
    if (m.t === "to" && typeof m.peer === "string" && m.patch && typeof m.patch === "object") {
      for (const k of IDENTITY) delete m.patch[k];
      const o = room.get(m.peer); if (o && !backedUp(o.ws)) send(o.ws, { t: "p", peer, patch: m.patch });
      return;
    }
    if (m.t === "follow") { me.following = typeof m.peer === "string" && m.peer !== peer ? m.peer : null; return; }
  });
  ws.on("close", () => {
    const b = keyId && keys.get(keyId); if (b && b.ws === ws) { b.ws = null; b.until = Date.now() + KEY_GRACE_MS; } // the owner may come back with its k
    if (!roomName) return;
    const room = rooms.get(roomName); if (!room) return;
    const me = room.get(peer);
    if (me && me.ws === ws) {
      room.delete(peer);
      const bye = JSON.stringify({ t: "bye", peer });
      for (const o of room.values()) { if (backedUp(o.ws)) o.stale = true; else sendRaw(o.ws, bye); }
      syncPeers(roomName, room, null);
    }
    if (!room.size) rooms.delete(roomName);
  });
  ws.on("error", () => {});
});
// drop dead sockets (phone went to sleep without closing) and receivers that stay hopelessly backed up; forget expired ids
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    if (ws.bufferedAmount > SEND_HARD) { if (ws.clogged) { warn(`dropped a receiver with ${ws.bufferedAmount} bytes queued`); try { ws.terminate(); } catch {} continue; } ws.clogged = true; } else ws.clogged = false;
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
  pruneKeys(Date.now(), true);
}, 6000);
// a receiver that was skipped while backed up gets the whole room again once it has drained
setInterval(() => {
  for (const room of rooms.values()) { let s = null; for (const m of room.values()) if (m.stale && m.ws.readyState === 1 && m.ws.bufferedAmount < SEND_SOFT / 2) syncOne(m, s || (s = peersMsg(room))); }
}, 1000);

server.listen(PORT, () => console.log(`vijuga-server listening on ${PORT}`));
// a new version is being deployed (the platform stops this process): everybody is told first, so the game can say
// "update in progress, please wait" instead of just losing the connection
let closing = false;
const shutdown = (sig) => { if (closing) return; closing = true; let n = 0; for (const ws of wss.clients) { if (ws.readyState === 1) { send(ws, { t: "note", m: "update" }); n++; } } console.log(`${sig}: told ${n} connections about the update`); setTimeout(() => process.exit(0), 1500).unref(); };
process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
