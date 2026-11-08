// Player profiles and leaderboard for Vijuga, kept in Netlify Blobs (one key per player).
// GET  /api/accounts            -> all public profiles (no PIN hashes)
// GET  /api/accounts/:slug      -> one public profile
// POST /api/accounts/:slug/login {pinHash} -> full profile when the PIN matches
// PUT  /api/accounts/:slug      {doc, auth} -> create, or update when auth matches the stored PIN hash
// DELETE /api/accounts/:slug    {auth} -> remove a PIN-protected profile
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STORE = "vijuga-accounts";
// SHA-256 of the maintenance key (same key as for matches); the key itself is not in the repository.
const ADMIN_KEY_SHA256 = "f5200fc8e8b6f62b67cebbfb4087e15b344faffeb42fe51c14c4957ce940c306";
const SLUG = /^[a-z0-9-]{1,40}$/;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

type Doc = Record<string, unknown> & { slug: string; name: string; pinHash?: string };

function publicView(d: Doc) {
  const { pinHash, ...rest } = d;
  return { ...rest, hasPin: !!pinHash };
}

function clean(input: unknown, slug: string): Doc | string {
  if (!input || typeof input !== "object") return "doc missing";
  const d = input as Record<string, unknown>;
  const name = String(d.name ?? "").trim();
  if (name.length < 1 || name.length > 14) return "name must be 1-14 characters";
  const num = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 20).slice(0, 60) : []);
  const eq = (d.eq && typeof d.eq === "object" ? d.eq : {}) as Record<string, unknown>;
  const doc: Doc = {
    slug,
    name,
    color: num(d.color, 5),
    coins: num(d.coins, 10_000_000),
    matches: num(d.matches, 1_000_000),
    wins: num(d.wins, 1_000_000),
    kills: num(d.kills, 10_000_000),
    owned: strArr(d.owned),
    spent: num(d.spent, 100_000_000),
    purchases: num(d.purchases, 100_000),
    playMs: num(d.playMs, 1e12),
    siteMs: num(d.siteMs, 1e12),
    trollsSent: num(d.trollsSent, 1_000_000),
    trollsGot: num(d.trollsGot, 1_000_000),
    inv: Object.fromEntries(Object.entries(d.inv && typeof d.inv === "object" ? (d.inv as Record<string, unknown>) : {}).filter(([k]) => /^[a-z]{2,12}$/.test(k)).slice(0, 30).map(([k, v]) => [k, num(v, 999)]).filter(([, v]) => (v as number) > 0)),
    eq: { skin: String(eq.skin ?? "sk_none").slice(0, 20), badge: String(eq.badge ?? "bd_none").slice(0, 20), pu: String(eq.pu ?? "").slice(0, 20) },
    bonus500: !!d.bonus500,
    created: num(d.created, 9e15),
    invitedBy: typeof d.invitedBy === "string" && /^[a-z0-9-]{1,40}$/.test(d.invitedBy) ? d.invitedBy : undefined,
    updatedAt: Date.now(),
  };
  if (typeof d.pinHash === "string" && /^[0-9a-f]{64}$/.test(d.pinHash)) doc.pinHash = d.pinHash;
  return doc;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: STORE, consistency: "strong" });
  const slug = context.params.slug;
  const action = context.params.action;

  if (!slug) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const { blobs } = await store.list();
    const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Doc | null>));
    const list = docs.filter((d): d is Doc => !!d).map(publicView);
    list.sort((a, b) => Number((b as Record<string, unknown>).coins) - Number((a as Record<string, unknown>).coins));
    return json({ accounts: list });
  }

  if (!SLUG.test(slug)) return json({ error: "bad slug" }, 400);
  const existing = (await store.get(slug, { type: "json" })) as Doc | null;

  if (req.method === "GET") {
    if (!existing) return json({ error: "not found" }, 404);
    return json({ account: publicView(existing) });
  }

  if (req.method === "POST" && action === "reset") {
    // Admin only: remove a forgotten PIN; the player then logs in without one and sets a new PIN.
    const given = req.headers.get("x-admin-key") || "";
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(given)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!given || digest !== ADMIN_KEY_SHA256) return json({ error: "forbidden" }, 403);
    if (!existing) return json({ error: "not found" }, 404);
    delete existing.pinHash; existing.updatedAt = Date.now();
    await store.setJSON(slug, existing);
    return json({ ok: true, account: publicView(existing) });
  }

  if (req.method === "POST" && action === "login") {
    if (!existing) return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as { pinHash?: string };
    if (existing.pinHash && body.pinHash !== existing.pinHash) return json({ error: "wrong pin" }, 403);
    return json({ account: existing });
  }

  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { doc?: unknown; auth?: string } | null;
    const doc = clean(body?.doc, slug);
    if (typeof doc === "string") return json({ error: doc }, 400);
    if (existing && existing.pinHash && body?.auth !== existing.pinHash) return json({ error: "wrong pin" }, 403);
    if (existing && existing.pinHash && !doc.pinHash) doc.pinHash = existing.pinHash;
    if (existing && existing.created) doc.created = existing.created as number;
    if (existing) doc.invitedBy = (existing.invitedBy as string | undefined) ?? doc.invitedBy;
    if (!existing && !doc.created) doc.created = Date.now();
    await store.setJSON(slug, doc);
    return json({ account: publicView(doc) });
  }

  if (req.method === "DELETE") {
    // Only a PIN-protected profile can be removed, and only with its PIN.
    if (!existing) return json({ ok: true });
    const body = (await req.json().catch(() => ({}))) as { auth?: string };
    if (!existing.pinHash || body.auth !== existing.pinHash) return json({ error: "wrong pin" }, 403);
    await store.delete(slug);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config: Config = {
  path: ["/api/accounts", "/api/accounts/:slug", "/api/accounts/:slug/:action"],
};
