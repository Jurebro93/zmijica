// Lobby chat history for Vijuga: messages stay so everyone (also who comes later) sees them, with the time sent.
// GET  /api/chat?room=<room>                      -> { msgs: [{id, sl, name, text, at}] }  (last 150)
// POST /api/chat {room, slug, auth, text, at}      -> appends one message (sender's PIN checked); text only, 80 chars
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, ROOM = /^vijuga-lobby(-[a-z0-9-]{1,24})?$/;
const KEEP = 150, DAYS = 30;
type Msg = { id: string; sl: string; name: string; text: string; at: number };

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: "vijuga-chat", consistency: "strong" });
  const url = new URL(req.url);
  if (req.method === "GET") {
    const room = String(url.searchParams.get("room") || "");
    if (!ROOM.test(room)) return json({ error: "bad room" }, 400);
    const msgs = ((await store.get(room, { type: "json" })) as Msg[] | null) || [];
    const since = Date.now() - DAYS * 86400000;
    return json({ msgs: msgs.filter((m) => m.at > since) });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "body missing" }, 400);
  const room = String(b.room ?? ""), slug = String(b.slug ?? ""), text = String(b.text ?? "").trim().slice(0, 80);
  if (!ROOM.test(room) || !SLUG.test(slug) || !text) return json({ error: "bad request" }, 400);
  const acc = (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null;
  if (!acc || (acc.pinHash && acc.pinHash !== b.auth)) return json({ error: "auth" }, 403);
  const at = Math.min(Date.now() + 60000, Math.max(Date.now() - 600000, Math.floor(Number(b.at) || Date.now())));
  const id = `${slug}:${at}`;
  const msgs = ((await store.get(room, { type: "json" })) as Msg[] | null) || [];
  if (msgs.some((m) => m.id === id)) return json({ ok: true, dup: true });
  msgs.push({ id, sl: slug, name: String(acc.name ?? slug).slice(0, 14), text, at });
  msgs.sort((x, y) => x.at - y.at);
  await store.setJSON(room, msgs.slice(-KEEP));
  return json({ ok: true });
};

export const config: Config = { path: "/api/chat" };
