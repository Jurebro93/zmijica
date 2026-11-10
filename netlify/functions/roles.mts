// Player roles for Vijuga. The master admin (jure) gives and takes roles; moderators can mute chat.
// GET  /api/roles                       -> { master, roles: {slug: role}, mutes: {slug: until} }
// POST /api/roles/set  {slug, auth, target, role}      (master only; role "" removes it)
// POST /api/roles/mute {slug, auth, target, minutes}   (moderator, admin, master; minutes 0 lifts it)
// POST /api/roles/grant {slug, auth, target, amount | item, note?}  (master only)
// POST /api/roles/treasury {slug, auth}                 (master only)
// Every action is privileged: the acting account must have a PIN (403 "pin needed"), checked through the shared limiter.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { authed as authedReq, cas } from "./guard.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
export const MASTER = "jure";
export const ROLES = ["admin", "turnir", "moderator"] as const;

export async function loadRoles() {
  const store = getStore({ name: "vijuga-roles", consistency: "strong" });
  const roles = ((await store.get("roles", { type: "json" })) as Record<string, string> | null) || {};
  const mutes = ((await store.get("mutes", { type: "json" })) as Record<string, number> | null) || {};
  for (const k of Object.keys(mutes)) if (mutes[k] < Date.now()) delete mutes[k];
  return { store, roles, mutes };
}
// the master admin's hidden treasury for tournament pots (starts at 10 000); changed with compare-and-swap, so two
// tournaments paid from it at the same moment both count
export async function treasury(change = 0) {
  const store = getStore({ name: "vijuga-roles", consistency: "strong" });
  if (!change) { const raw = await store.get("treasury"); return { ok: true, value: raw == null ? 10000 : Number(raw) || 0 }; }
  let ok = true, value = 0;
  await cas<number>(store, "treasury", (cur) => { const v = cur == null ? 10000 : Number(cur) || 0; ok = v + change >= 0; value = ok ? v + change : v; return ok ? value : undefined; });
  return { ok, value };
}
export async function roleOf(slug: string) { if (slug === MASTER) return "master"; const { roles } = await loadRoles(); return roles[slug] || ""; }

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const { store, roles, mutes } = await loadRoles();
  if (req.method === "GET") return json({ master: MASTER, roles, mutes });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""), target = String(b.target ?? "");
  // every action here is privileged: an account without a PIN proves nothing (anyone can act as it)
  const { gate } = await authedReq(req, context, slug, b.auth, { requirePin: true });
  if (!gate.ok) return gate.status === 429 ? json({ error: gate.error, wait: gate.wait }, 429) : json({ error: gate.error === "pin needed" ? "pin needed" : "auth" }, 403);
  if (context.params.action !== "treasury" && (!SLUG.test(target) || (target === MASTER && context.params.action !== "grant"))) return json({ error: "bad target" }, 400);
  const mine = slug === MASTER ? "master" : roles[slug] || "";
  if (context.params.action === "set") {
    if (mine !== "master") return json({ error: "master only" }, 403);
    const role = String(b.role ?? "");
    if (role && !(ROLES as readonly string[]).includes(role)) return json({ error: "bad role" }, 400);
    const next = await cas<Record<string, string>>(store, "roles", (cur) => { const r = cur || {}; if (role) r[target] = role; else delete r[target]; return r; });
    return json({ master: MASTER, roles: next, mutes });
  }
  if (context.params.action === "grant") {
    // master gives a player coins (as a gift the player's game collects on its next load)
    if (mine !== "master") return json({ error: "master only" }, 403);
    const item = typeof b.item === "string" && /^[a-z]{2,12}$/.test(b.item) && b.item !== "coins" ? b.item : null;
    const raw = Number(b.amount), amount = Number.isFinite(raw) ? Math.floor(raw) : 0; if (!item && (amount < 1 || amount > 50000)) return json({ error: "bad amount" }, 400);
    const acc = await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(target, { type: "json" }) as Record<string, unknown> | null; if (!acc) return json({ error: "unknown player" }, 404);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${target}/${id}`, { id, from: "admin", fromName: String(b.note ?? "").slice(0, 40) || "Admin: bonus", item: item || "coins:" + amount, at: Date.now() });
    return json({ ok: true, id, amount, item });
  }
  if (context.params.action === "treasury") {
    if (mine !== "master") return json({ error: "master only" }, 403);
    return json({ treasury: (await treasury()).value });
  }
  if (context.params.action === "mute") {
    if (!["master", "admin", "moderator"].includes(mine)) return json({ error: "moderators only" }, 403);
    if (target === slug) return json({ error: "bad target" }, 400);
    if (roles[target] === "admin" && mine !== "master") return json({ error: "cannot mute an admin" }, 403);
    const minutes = Math.max(0, Math.min(1440, Math.floor(Number(b.minutes) || 0)));
    const next = await cas<Record<string, number>>(store, "mutes", (cur) => { const m = cur || {}; for (const k of Object.keys(m)) if (m[k] < Date.now()) delete m[k]; if (minutes) m[target] = Date.now() + minutes * 60000; else delete m[target]; return m; });
    return json({ master: MASTER, roles, mutes: next });
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/roles", "/api/roles/:action"] };
