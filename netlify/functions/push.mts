// Web push for Vijuga (invites and meeting reminders).
// GET  /api/push/key                         -> VAPID public key (created once, kept in Blobs)
// POST /api/push/subscribe {slug, auth, sub} -> save this device for the player (PIN checked)
// POST /api/push/invite {from, to, auth, kind?} -> notify a player that a friend calls them to play (kind "poke": a nudge to come back)
// GET  /api/push/has?slugs=a,b               -> which of these players can get notifications
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const GAME = "https://zmijica.onrender.com/";

export async function vapid() {
  const store = getStore({ name: "vijuga-push", consistency: "strong" });
  let keys = (await store.get("vapid", { type: "json" })) as { publicKey: string; privateKey: string } | null;
  if (!keys) { keys = webpush.generateVAPIDKeys(); await store.setJSON("vapid", keys); }
  webpush.setVapidDetails(GAME, keys.publicKey, keys.privateKey);
  return { store, keys };
}

export async function sendTo(slug: string, payload: Record<string, unknown>) {
  const { store } = await vapid();
  const subs = ((await store.get("subs/" + slug, { type: "json" })) as webpush.PushSubscription[] | null) || [];
  let sent = 0; const keep: webpush.PushSubscription[] = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600 }); sent++; keep.push(sub); }
    catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code !== 404 && code !== 410) keep.push(sub); }
  }
  if (keep.length !== subs.length) await store.setJSON("subs/" + slug, keep);
  return sent;
}

async function account(slug: string) {
  return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const action = context.params.action;
  const { store, keys } = await vapid();
  if (req.method === "GET" && action === "key") return json({ key: keys.publicKey });
  if (req.method === "GET" && action === "has") {
    const slugs = (new URL(req.url).searchParams.get("slugs") || "").split(",").filter((s) => SLUG.test(s)).slice(0, 60);
    const has: string[] = [];
    for (const s of slugs) { const v = (await store.get("subs/" + s, { type: "json" })) as unknown[] | null; if (v && v.length) has.push(s); }
    return json({ has });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "body missing" }, 400);
  if (action === "subscribe") {
    const slug = String(b.slug ?? ""); const sub = b.sub as webpush.PushSubscription | undefined;
    if (!SLUG.test(slug) || !sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return json({ error: "bad request" }, 400);
    const acc = await account(slug); if (!acc) return json({ error: "unknown player" }, 404);
    if (acc.pinHash && acc.pinHash !== b.auth) return json({ error: "wrong pin" }, 403);
    const subs = ((await store.get("subs/" + slug, { type: "json" })) as webpush.PushSubscription[] | null) || [];
    const next = [sub, ...subs.filter((x) => x.endpoint !== sub.endpoint)].slice(0, 4);
    await store.setJSON("subs/" + slug, next);
    return json({ ok: true });
  }
  if (action === "invite") {
    const from = String(b.from ?? ""), to = String(b.to ?? "");
    if (!SLUG.test(from) || !SLUG.test(to) || from === to) return json({ error: "bad request" }, 400);
    const acc = await account(from); if (!acc) return json({ error: "unknown player" }, 404);
    if (acc.pinHash && acc.pinHash !== b.auth) return json({ error: "wrong pin" }, 403);
    const key = `rate/${from}/${to}`; const last = Number(await store.get(key)) || 0;
    if (Date.now() - last < 60000) return json({ error: "wait a minute" }, 429);
    await store.set(key, String(Date.now()));
    const who = String(acc.name ?? from).slice(0, 14), poke = b.kind === "poke";
    const sent = await sendTo(to, poke
      ? { title: `👉 ${who} te bocnuo!`, body: "Vrati se u igru, čekamo te za meč 🐍 Dodirni da uđeš.", url: GAME, tag: "poke-" + from }
      : { title: `🐍 ${who} te zove na Vijugu!`, body: "Dođi, čekamo te za meč. Dodirni da uđeš.", url: GAME, tag: "invite-" + from });
    return sent ? json({ ok: true, sent }) : json({ error: "no devices" }, 404);
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: "/api/push/:action" };
