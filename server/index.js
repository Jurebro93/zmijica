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
const MAX_MSG = 200_000; // bytes; voice messages are ~90 kB

/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, presence: Record<string, unknown>, following: string|null, alive: boolean}>>} */
const rooms = new Map();
let msgCount = 0;

const server = http.createServer((req, res) => {
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
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== "object") return;
    msgCount++;
    if (m.t === "hi") {
      if (roomName) return;
      if (!ROOM_RE.test(String(m.room)) || !PEER_RE.test(String(m.peer))) { send(ws, { t: "err", e: "bad hi" }); ws.close(); return; }
      roomName = m.room; peer = m.peer;
      const room = roomOf(roomName);
      const old = room.get(peer); if (old && old.ws !== ws) { try { old.ws.close(); } catch {} }
      room.set(peer, { ws, presence: (old && old.presence) || {}, following: null, alive: true });
      send(ws, { t: "hello", peer, now: Date.now() });
      syncPeers(room);
      return;
    }
    if (!roomName) return;
    const room = rooms.get(roomName); const me = room && room.get(peer); if (!me || me.ws !== ws) return;
    if (m.t === "ping") { send(ws, { t: "pong", n: m.n, now: Date.now() }); return; }
    if (m.t === "pres" && m.patch && typeof m.patch === "object") {
      for (const k in m.patch) { if (m.patch[k] === null) delete me.presence[k]; else me.presence[k] = m.patch[k]; }
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      for (const [k, o] of room) if (k !== peer && o.ws.readyState === 1) o.ws.send(out);
      return;
    }
    if (m.t === "own" && m.patch && typeof m.patch === "object") {
      const out = JSON.stringify({ t: "p", peer, patch: m.patch });
      for (const [k, o] of room) if (k !== peer && o.following === peer && o.ws.readyState === 1) o.ws.send(out);
      return;
    }
    if (m.t === "to" && typeof m.peer === "string" && m.patch && typeof m.patch === "object") {
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
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 15000);

server.listen(PORT, () => console.log(`vijuga-server listening on ${PORT}`));
