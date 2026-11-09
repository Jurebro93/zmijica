// Vijuga realtime server: rooms with presence, direct messages and per-host match channels.
// A drop-in replacement for the Supabase Realtime layer, without rate limits or dropped channels.
//   client -> server:  {t:'hi', room, peer}            join a room with my peer id
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
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const ROOM_RE = /^vijuga-lobby(-[a-z0-9-]{1,24})?$/, PEER_RE = /^[a-z0-9]{4,16}$/;
const MAX_MSG = 700_000; // bytes; voice messages can reach a few hundred kB on some phones
const TRANSIENT = new Set(["msg", "re", "ping", "pong", "dm", "bt"]); // relayed, never kept in presence
const IDENTITY = ["sl", "nm", "st", "hs", "pls", "pmid", "cl"]; // a direct message may not forge who the sender is or what match they host
const MAX_PRES = 64_000; // bytes; a presence patch without a transient key (chat/voice) is lobby state and must stay small
const RATE_BURST = 150, RATE_PER_SEC = 60; // per connection: a host sends ~15 snapshots + inputs per second

// an old connection answers a ping within a few seconds; a zombie (phone asleep, network changed) does not
const alive = (ws, ms = 3000) => new Promise((ok) => {
  if (ws.readyState !== 1) return ok(false);
  let done = false; const fin = (v) => { if (!done) { done = true; ws.off("pong", onPong); ok(v); } }; const onPong = () => fin(true);
  ws.once("pong", onPong); try { ws.ping(); } catch { fin(false); } setTimeout(() => fin(false), ms);
});

/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, presence: Record<string, unknown>, following: string|null, alive: boolean}>>} */
const rooms = new Map();
let msgCount = 0;

const server = http.createServer((req, res) => {
  let url; try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); res.end(); return; } // a malformed request must not take the relay down
  if (url.pathname === "/peers") { // who is in a room (for the stats page); only lobby fields
    const room = rooms.get(String(url.searchParams.get("room") || ""));
    const keep = ["nm", "sl", "cl", "rd", "hs", "ig", "pl", "watch", "pg", "obs"];
    const peers = room ? [...room.entries()].map(([peer, m]) => ({ peer, presence: Object.fromEntries(keep.filter((k) => k in m.presence).map((k) => [k, m.presence[k]])) })) : [];
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({ peers })); return;
  }
  const stats = { ok: true, rooms: rooms.size, peers: [...rooms.values()].reduce((s, r) => s + r.size, 0), msgs: msgCount, up: Math.round(process.uptime()) };
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(JSON.stringify(stats));
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

const send = (ws, obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } };
const roomOf = (name) => { let r = rooms.get(name); if (!r) { r = new Map(); rooms.set(name, r); } return r; };
const syncPeers = (room) => { const peers = [...room.entries()].map(([peer, m]) => ({ peer, presence: m.presence })); for (const m of room.values()) send(m.ws, { t: "peers", peers }); };

wss.on("connection", (ws) => {
  let roomName = null, peer = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  let tokens = RATE_BURST, lastFill = Date.now(), joining = false;
  ws.on("message", async (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== "object") return;
    const now = Date.now(); tokens = Math.min(RATE_BURST, tokens + (now - lastFill) / 1000 * RATE_PER_SEC); lastFill = now;
    if (tokens < 1) return; tokens--; // flooding peers are throttled, not relayed
    msgCount++;
    if (m.t === "hi") {
      if (roomName || joining) return;
      if (!ROOM_RE.test(String(m.room)) || !PEER_RE.test(String(m.peer))) { send(ws, { t: "err", e: "bad hi" }); ws.close(); return; }
      const room = roomOf(m.room);
      const old = room.get(m.peer);
      if (old && old.ws !== ws) {
        // the peer id is public, so a newcomer may only replace a connection that no longer answers (the player's own reconnect)
        joining = true; const stillThere = await alive(old.ws); joining = false;
        if (ws.readyState !== 1) return;
        if (stillThere && room.get(m.peer) === old) { send(ws, { t: "err", e: "taken" }); ws.close(); return; }
        try { old.ws.close(); } catch {}
      }
      roomName = m.room; peer = m.peer;
      room.set(peer, { ws, presence: (old && old.presence) || {}, following: null, alive: true });
      send(ws, { t: "hello", peer, now: Date.now() });
      syncPeers(room);
      return;
    }
    if (!roomName) return;
    const room = rooms.get(roomName); const me = room && room.get(peer); if (!me || me.ws !== ws) return;
    if (m.t === "ping") { send(ws, { t: "pong", n: m.n, now: Date.now() }); return; }
    if (m.t === "pres" && m.patch && typeof m.patch === "object") {
      if (buf.length > MAX_PRES && !Object.keys(m.patch).some((k) => TRANSIENT.has(k))) return;
      for (const k in m.patch) { if (TRANSIENT.has(k)) continue; if (m.patch[k] === null) delete me.presence[k]; else me.presence[k] = m.patch[k]; }
      // the same account on a new connection (reload, network change): the old connection is a ghost -> drop it,
      // but only once it has stopped answering, so nobody can kick a live player just by claiming their slug
      const sl = typeof m.patch.sl === "string" ? m.patch.sl : null;
      if (sl && me.presence.pg !== "stats" && !me.presence.obs) {
        for (const [k, o] of [...room]) if (k !== peer && o.presence.sl === sl && o.presence.pg !== "stats" && !o.presence.obs && !o.checking) {
          o.checking = true;
          alive(o.ws).then((there) => { o.checking = false; if (there || room.get(k) !== o || room.get(peer) !== me) return; send(o.ws, { t: "replaced" }); setTimeout(() => { try { o.ws.close(4001, "replaced"); } catch {} }, 50); room.delete(k); for (const q of room.values()) send(q.ws, { t: "bye", peer: k }); });
        }
      }
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      for (const [k, o] of room) if (k !== peer && o.ws.readyState === 1) o.ws.send(out);
      return;
    }
    if (m.t === "own" && m.patch && typeof m.patch === "object") {
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      // a follower whose connection is backed up gets the next snapshot instead of a growing queue
      for (const [k, o] of room) if (k !== peer && o.following === peer && o.ws.readyState === 1 && o.ws.bufferedAmount < 65536) o.ws.send(out);
      return;
    }
    if (m.t === "to" && typeof m.peer === "string" && m.patch && typeof m.patch === "object") {
      for (const k of IDENTITY) delete m.patch[k];
      const o = room.get(m.peer); if (o) send(o.ws, { t: "p", peer, patch: m.patch });
      return;
    }
    if (m.t === "follow") { me.following = typeof m.peer === "string" && m.peer !== peer ? m.peer : null; return; }
  });
  ws.on("close", () => {
    if (!roomName) return;
    const room = rooms.get(roomName); if (!room) return;
    const me = room.get(peer); if (me && me.ws === ws) { room.delete(peer); for (const o of room.values()) send(o.ws, { t: "bye", peer }); syncPeers(room); }
    if (!room.size) rooms.delete(roomName);
  });
  ws.on("error", () => {});
});
// drop dead sockets (phone went to sleep without closing)
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 6000);

server.listen(PORT, () => console.log(`vijuga-server listening on ${PORT}`));
