// Lobby chat history for Vijuga: messages stay so everyone (also who comes later) sees them, with the time sent.
// GET  /api/chat?room=<room>                      -> { msgs: [{id, sl, name, text, at}] }  (last 150)
// POST /api/chat {room, slug, auth, text, at}      -> appends one message (sender's PIN checked); text only, 80 chars
// A sender may post 5 messages in 10 s and 30 in 5 min (an address: 10 in 10 s, 60 in 5 min); more -> 429 {error:
// "slow down", wait}. Messages are appended with compare-and-swap, so two at the same moment are both kept.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { loadRoles } from "./roles.mts";
import { account, cas, hit, ipKey, pinGate } from "./guard.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, ROOM = /^vijuga-lobby(-[a-z0-9-]{1,24})?$/;
const KEEP = 150, DAYS = 30, S10 = 10_000, M5 = 5 * 60_000;
type Msg = { id: string; sl: string; name: string; text: string; at: number };

export default async (req: Request, context: Context) => {
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
  const acc = await account(slug); if (!acc) return json({ error: "auth" }, 403);
  const g = await pinGate(req, context, slug, acc.pinHash, b.auth);
  if (!g.ok) return g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error: "auth" }, 403);
  const { mutes } = await loadRoles(); if ((mutes[slug] || 0) > Date.now()) return json({ error: "muted", until: mutes[slug] }, 403);
  const at = Math.min(Date.now() + 60000, Math.max(Date.now() - 600000, Math.floor(Number(b.at) || Date.now())));
  const id = `${slug}:${at}`;
  const cur = ((await store.get(room, { type: "json" })) as Msg[] | null) || [];
  if (cur.some((m) => m.id === id)) return json({ ok: true, dup: true }); // a resend of the same message costs nothing
  const [bySender, byIp] = await Promise.all([hit("chat/" + slug, [[5, S10], [30, M5]]), hit("chatip/" + (await ipKey(req, context)), [[10, S10], [60, M5]])]);
  if (!bySender.ok || !byIp.ok) return json({ error: "slow down", wait: Math.max(bySender.wait, byIp.wait) }, 429);
  let dup = false;
  await cas<Msg[]>(store, room, (list) => {
    const msgs = list || []; dup = msgs.some((m) => m.id === id); if (dup) return undefined;
    msgs.push({ id, sl: slug, name: String(acc.name ?? slug).slice(0, 14), text, at });
    msgs.sort((x, y) => x.at - y.at);
    return msgs.slice(-KEEP);
  });
  return json(dup ? { ok: true, dup: true } : { ok: true });
};

export const config: Config = { path: "/api/chat" };
