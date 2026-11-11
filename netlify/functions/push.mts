// Web push for Vijuga (invites, pokes and news).
// GET  /api/push/key                         -> VAPID public key (created once, kept in Blobs)
// POST /api/push/subscribe {slug, auth, sub} -> save this device for the player (PIN checked)
// POST /api/push/invite {from, to, auth, kind?} -> notify a player that a friend calls them to play (kind "poke": a nudge to come back)
// POST /api/push/has {slug, auth, slugs}     -> which of these players can get notifications (signed-in players only;
//                                               GET /api/push/has answers 401: it no longer tells strangers)
// POST /api/push/broadcast {slug, auth, id, title, body} -> the master tells every subscribed phone about something new
//                                               (once per news id, at most once an hour)
// POST /api/push/callall {from, auth, claim, skip, waiting} -> "X te zove na Vijugu": every player with notifications,
//                                               except the caller and the players already in the lobby (skip). One call a
//                                               player per 20 minutes (6 a day); a phone gets at most 3 of these an hour;
//                                               a muted player cannot call. Answers {ok, players, sent, limited}.
// GET  /api/push/count                       -> how many players have notifications on (a number, no names)
// Invites: one per sender and receiver a minute, and per sender 10 in 10 minutes and 40 a day (429 {error, wait}).
// Every PIN check goes through the shared failure limiter; each phone gets 4 s to answer.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { MASTER } from "./roles.mts";
import { account, hit, pinGate } from "./guard.mts";
import { loadRoles } from "./roles.mts";
import { owns } from "./wallet.mts";

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

const SEND_MS = 4000;
const CALL_GAP = 20 * 60000, RCV_HOUR = 3; // call-all: per caller, per receiving player
// one phone that does not answer must not hold the function past its time limit
function sendOne(sub: webpush.PushSubscription, payload: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(Object.assign(new Error("timeout"), { statusCode: 0 })), SEND_MS + 500); });
  return Promise.race([webpush.sendNotification(sub, payload, { TTL: 600, timeout: SEND_MS }), late]).finally(() => clearTimeout(timer));
}
export async function sendTo(slug: string, payload: Record<string, unknown>) {
  const { store } = await vapid();
  const subs = ((await store.get("subs/" + slug, { type: "json" })) as webpush.PushSubscription[] | null) || [];
  const res = await Promise.all(subs.map((sub) => sendOne(sub, JSON.stringify(payload)).then(() => 1, (e) => { const code = (e as { statusCode?: number }).statusCode; return code === 404 || code === 410 ? -1 : 0; })));
  const keep = subs.filter((_, i) => res[i] !== -1);
  if (keep.length !== subs.length) await store.setJSON("subs/" + slug, keep);
  return res.filter((x) => x === 1).length;
}
const refused = (g: { ok: boolean; status?: number; error?: string; wait?: number }, error: string) => g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error }, 403);

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const action = context.params.action;
  const { store, keys } = await vapid();
  if (req.method === "GET" && action === "key") return json({ key: keys.publicKey });
  if (req.method === "GET" && action === "has") return json({ error: "auth" }, 401); // who can be notified is not for strangers
  if (req.method === "GET" && action === "count") { // how many, never who
    const { blobs } = await store.list({ prefix: "subs/" });
    const lists = await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" }) as Promise<unknown[] | null>));
    return Response.json({ n: lists.filter((v) => Array.isArray(v) && v.length).length }, { headers: { ...cors, "cache-control": "public, max-age=0, s-maxage=120", "netlify-cdn-cache-control": "public, s-maxage=120" } });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "body missing" }, 400);
  if (action === "has") {
    const slug = String(b.slug ?? ""); const acc = await account(slug); if (!acc) return json({ error: "auth" }, 403);
    const g = await pinGate(req, context, slug, acc.pinHash, b.auth); if (!g.ok) return refused(g, "auth");
    const slugs = (Array.isArray(b.slugs) ? b.slugs.map(String) : String(b.slugs ?? "").split(",")).filter((s) => SLUG.test(s)).slice(0, 60);
    const subs = await Promise.all(slugs.map((s) => store.get("subs/" + s, { type: "json" }) as Promise<unknown[] | null>));
    return json({ has: slugs.filter((_, i) => { const v = subs[i]; return !!(v && v.length); }) });
  }
  if (action === "subscribe") {
    const slug = String(b.slug ?? ""); const sub = b.sub as webpush.PushSubscription | undefined;
    if (!SLUG.test(slug) || !sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return json({ error: "bad request" }, 400);
    const acc = await account(slug); if (!acc) return json({ error: "unknown player" }, 404);
    const g = await pinGate(req, context, slug, acc.pinHash, b.auth); if (!g.ok) return refused(g, "wrong pin");
    const subs = ((await store.get("subs/" + slug, { type: "json" })) as webpush.PushSubscription[] | null) || [];
    const next = [sub, ...subs.filter((x) => x.endpoint !== sub.endpoint)].slice(0, 4);
    await store.setJSON("subs/" + slug, next);
    return json({ ok: true });
  }
  if (action === "invite") {
    const from = String(b.from ?? ""), to = String(b.to ?? "");
    if (!SLUG.test(from) || !SLUG.test(to) || from === to) return json({ error: "bad request" }, 400);
    const acc = await account(from); if (!acc) return json({ error: "unknown player" }, 404);
    const g = await pinGate(req, context, from, acc.pinHash, b.auth); if (!g.ok) return refused(g, "wrong pin");
    const key = `rate/${from}/${to}`; const last = Number(await store.get(key)) || 0;
    if (Date.now() - last < 60000) return json({ error: "wait a minute" }, 429);
    const h = await hit("push/" + from, [[10, 10 * 60000], [40, 24 * 3600000]]); // and not more than this to everybody together
    if (!h.ok) return json({ error: "too many invites", wait: h.wait }, 429);
    await store.set(key, String(Date.now()));
    const who = String(acc.name ?? from).slice(0, 14), poke = b.kind === "poke";
    const sent = await sendTo(to, poke
      ? { title: `👉 ${who} te bocnuo!`, body: "Vrati se u igru, čekamo te za meč 🐍 Dodirni da uđeš.", url: GAME, tag: "poke-" + from }
      : { title: `🐍 ${who} te zove na Vijugu!`, body: "Dođi, čekamo te za meč. Dodirni da uđeš.", url: GAME, tag: "invite-" + from });
    return sent ? json({ ok: true, sent }) : json({ error: "no devices" }, 404);
  }
  if (action === "callall") {
    const from = String(b.from ?? ""); if (!SLUG.test(from)) return json({ error: "bad request" }, 400);
    const acc = await account(from); if (!acc) return json({ error: "unknown player" }, 404);
    const g = await pinGate(req, context, from, acc.pinHash, b.auth); if (!g.ok) return refused(g, "wrong pin");
    if (!acc.pinHash && acc.claimHash && !(await owns(acc, b.claim))) return json({ error: "auth" }, 403); // a PIN-less profile: only its own device
    const { mutes } = await loadRoles(); if ((Number(mutes[from]) || 0) > Date.now()) return json({ error: "muted", until: mutes[from] }, 403);
    const h = await hit("callall/" + from, [[1, CALL_GAP], [6, 24 * 3600000]]);
    if (!h.ok) return json({ error: "too soon", wait: h.wait }, 429);
    const skip = new Set((Array.isArray(b.skip) ? b.skip : []).map(String).filter((s) => SLUG.test(s)).slice(0, 80)); skip.add(from);
    const waiting = Math.max(0, Math.min(99, Math.floor(Number(b.waiting) || 0)));
    const { blobs } = await store.list({ prefix: "subs/" });
    const now = Date.now(), seen = ((await store.get("callall/rcv", { type: "json" })) as Record<string, number[]> | null) || {};
    const recent: Record<string, number[]> = {}; for (const [k, v] of Object.entries(seen)) { const t = (Array.isArray(v) ? v : []).filter((x) => x > now - 3600000); if (t.length) recent[k] = t; }
    const all = blobs.map((x) => x.key.slice(5)).filter((s) => SLUG.test(s) && !skip.has(s));
    const to = all.filter((s) => (recent[s] || []).length < RCV_HOUR), limited = all.length - to.length;
    const who = String(acc.name ?? from).slice(0, 14);
    const payload = { title: `📣 ${who} te zove na Vijugu!`, body: waiting > 1 ? `${waiting} igrača čeka u predvorju. Dodirni da uđeš u igru 🐍` : "Kreće meč, dođi u predvorje. Dodirni da uđeš u igru 🐍", url: GAME + "?tab=online", tag: "callall" };
    let sent = 0, players = 0, i = 0; const t0 = Date.now();
    for (; i < to.length && Date.now() - t0 < 4000; i += 25) { // 25 players at a time, each phone with its own time limit
      const batch = to.slice(i, i + 25), ns = await Promise.all(batch.map((s) => sendTo(s, payload).catch(() => 0)));
      ns.forEach((n, j) => { sent += n; if (n) { players++; (recent[batch[j]] = recent[batch[j]] || []).push(now); } });
    }
    await store.setJSON("callall/rcv", recent);
    return json({ ok: true, players, sent, limited, ...(i < to.length ? { partial: true } : {}) });
  }
  if (action === "broadcast") {
    const slug = String(b.slug ?? ""); const acc = slug === MASTER ? await account(slug) : null;
    if (!acc) return json({ error: "master only" }, 403);
    const g = await pinGate(req, context, slug, acc.pinHash, b.auth, { requirePin: true }); if (!g.ok) return refused(g, "master only");
    const id = String(b.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40), title = String(b.title ?? "").slice(0, 80), body = String(b.body ?? "").slice(0, 200);
    if (!title) return json({ error: "bad request" }, 400);
    if (id && (await store.get("broadcast/sent/" + id))) return json({ error: "already sent" }, 409);
    const last = Number(await store.get("broadcast/last")) || 0; if (Date.now() - last < 3600000) return json({ error: "wait" }, 429);
    await store.set("broadcast/last", String(Date.now())); if (id) await store.set("broadcast/sent/" + id, String(Date.now()));
    const { blobs } = await store.list({ prefix: "subs/" }); let sent = 0, players = 0;
    const tag = "news-" + (id || Date.now()), t0 = Date.now(); let i = 0;
    for (; i < blobs.length && Date.now() - t0 < 4000; i += 25) { // 25 players at a time, each phone with its own time limit
      const ns = await Promise.all(blobs.slice(i, i + 25).map((x) => sendTo(x.key.slice(5), { title, body, url: GAME, tag }).catch(() => 0)));
      for (const n of ns) { sent += n; if (n) players++; }
    }
    return json({ ok: true, sent, players, ...(i < blobs.length ? { partial: true } : {}) }); // the function's time ran out first
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: "/api/push/:action" };
