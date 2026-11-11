// Player profiles and leaderboard for Vijuga, kept in Netlify Blobs (one key per player).
// GET  /api/accounts            -> all public profiles (no PIN hashes, no private room codes), served from one index blob
//                                  and cached by the CDN for 30 s
// GET  /api/accounts/:slug      -> one public profile
// POST /api/accounts/:slug/login {pinHash} -> full profile when the PIN matches (wrong PINs limited per address+account)
// PUT  /api/accounts/:slug      {doc, auth} -> create (limited per address), or update when auth matches the stored PIN hash
// DELETE /api/accounts/:slug    {auth} -> remove a PIN-protected profile
// Every PIN check goes through the shared failure limiter (guard.mts): 429 {error: "too many attempts", wait} while locked.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { roleOf } from "./roles.mts";
import { accountsIndex, cas, hit, ipKey, later, pinGate, publicView, sha256, type Gate } from "./guard.mts";
import { guardSave, noteCut, ownersFor } from "./wallet.mts";
import { sendTo } from "./push.mts";

const STORE = "vijuga-accounts";
// SHA-256 of the maintenance key (same key as for matches); the key itself is not in the repository.
const ADMIN_KEY_SHA256 = "f5200fc8e8b6f62b67cebbfb4087e15b344faffeb42fe51c14c4957ce940c306";
const SLUG = /^[a-z0-9-]{1,40}$/;
const HOUR = 3600000;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const refused = (g: Gate, error = "wrong pin") => g.ok ? null : g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error }, 403);

type Doc = Record<string, unknown> & { slug: string; name: string; pinHash?: string };

// what the owner gets back after a save: everything but the PIN hash (the private room code included)
const newClaim = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
function ownerView(d: Doc) {
  const { pinHash, wal, claimHash, ...rest } = d; // wal: the day's wallet counters (wallet.mts), kept on the server only
  return { ...rest, hasPin: !!pinHash };
}

function clean(input: unknown, slug: string): Doc | string {
  if (!input || typeof input !== "object") return "doc missing";
  const d = input as Record<string, unknown>;
  const name = String(d.name ?? "").trim();
  if (name.length < 1 || name.length > 14) return "name must be 1-14 characters";
  const num = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 20).slice(0, 400) : []); // the catalog is near 200 items: room for a full collection
  const eq = (d.eq && typeof d.eq === "object" ? d.eq : {}) as Record<string, unknown>;
  const doc: Doc = {
    slug,
    name,
    color: num(d.color, 7), // an index into the game's 8 colours
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
    xpb: num(d.xpb, 100_000_000), // XP bought (XP kutije) and bonus XP (bigger matches, the double-XP potion)
    xpx: num(d.xpx, 9_999), // matches left with double XP
    daily: d.daily && typeof d.daily === "object" && typeof (d.daily as Record<string, unknown>).d === "string" ? { d: String((d.daily as Record<string, unknown>).d).slice(0, 10), c: Object.fromEntries(Object.entries(((d.daily as Record<string, unknown>).c as Record<string, unknown>) || {}).slice(0, 10).map(([k, v]) => [k.slice(0, 6), num(v, 10000)])), done: strArr((d.daily as Record<string, unknown>).done).slice(0, 10) } : undefined,
    inv: Object.fromEntries(Object.entries(d.inv && typeof d.inv === "object" ? (d.inv as Record<string, unknown>) : {}).filter(([k]) => /^[a-z]{2,12}$/.test(k)).slice(0, 30).map(([k, v]) => [k, num(v, 999)]).filter(([, v]) => (v as number) > 0)),
    eq: { skin: String(eq.skin ?? "sk_none").slice(0, 20), badge: String(eq.badge ?? "bd_none").slice(0, 20), pu: String(eq.pu ?? "").slice(0, 20), te: String(eq.te ?? "").slice(0, 20), ds: String(eq.ds ?? "").slice(0, 20), vs: String(eq.vs ?? "").slice(0, 20), bg: String(eq.bg ?? "").slice(0, 20), cc: String(eq.cc ?? "").slice(0, 20), lux: String(eq.lux ?? "").replace(/[^a-z]/g, "").slice(0, 12), bx: (Array.isArray(eq.bx) ? eq.bx : []).map((x) => String(x)).filter((x) => /^bd_[a-z0-9_]{1,20}$/.test(x)).slice(0, 3) },
    title: typeof d.title === "string" ? d.title.replace(/[<>]/g, "").slice(0, 24) : undefined,
    bonus500: !!d.bonus500,
    lastMatchDay: typeof d.lastMatchDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.lastMatchDay) ? d.lastMatchDay : undefined,
    dayM: d.dayM && typeof d.dayM === "object" ? { d: String((d.dayM as Record<string, unknown>).d ?? "").slice(0, 10), n: num((d.dayM as Record<string, unknown>).n, 9999) } : undefined,
    box: d.box && typeof d.box === "object" ? { d: String((d.box as Record<string, unknown>).d ?? "").slice(0, 10), n: num((d.box as Record<string, unknown>).n, 999) } : undefined,
    room: typeof d.room === "string" && /^[a-z0-9]{4,8}$/.test(d.room) ? d.room : undefined,
    created: num(d.created, 9e15),
    invitedBy: typeof d.invitedBy === "string" && /^[a-z0-9-]{1,40}$/.test(d.invitedBy) ? d.invitedBy : undefined,
    updatedAt: Date.now(),
  };
  if (typeof d.pinHash === "string" && /^[0-9a-f]{64}$/.test(d.pinHash)) doc.pinHash = d.pinHash;
  return doc;
}

// the player who invited this one hears about it: when the new account is made through their link, and when it has
// played the 10 matches that pay the invitation (the game pays it, on the inviter's phone, with the other conditions)
const GAME_URL = "https://zmijica.onrender.com/", REF_MATCHES = 10;
export async function tellInviter(slug: string, existing: Doc | null, next: Doc) {
  const inv = typeof next.invitedBy === "string" ? next.invitedBy : "";
  if (!inv || inv === slug) return 0;
  const name = String(next.name || slug).slice(0, 24), was = Number(existing?.matches) || 0, now = Number(next.matches) || 0;
  if (!existing) return sendTo(inv, { title: "🎉 Novi igrač preko tvog linka", body: `${name} je sad u Vijugi, preko tvog linka. Nakon ${REF_MATCHES} mečeva dobivaš 3000 zlatnika.`, url: GAME_URL, tag: "ref-" + slug });
  if (was < REF_MATCHES && now >= REF_MATCHES) return sendTo(inv, { title: `💰 ${name}: odigrano ${REF_MATCHES} mečeva`, body: "Tvoj pozvani igrač stvarno igra. Otvori Vijugu: 3000 zlatnika stiže čim mu račun bude star 2 dana i ima 20 min igre.", url: GAME_URL, tag: "ref-" + slug });
  return 0;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: STORE, consistency: "strong" });
  const slug = context.params.slug;
  const action = context.params.action;

  if (!slug) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    // one blob instead of one per player; every client polls this, so the CDN answers it for 30 s
    // the order the old per-blob listing gave: by coins, equal coins by slug (the blob key order)
    const bySlug = (a: Record<string, unknown>, b: Record<string, unknown>) => (String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0);
    const list = Object.values(await accountsIndex.read()).sort(bySlug);
    list.sort((a, b) => Number(b.coins) - Number(a.coins));
    return Response.json({ accounts: list }, { headers: { ...cors, "cache-control": "public, max-age=0, s-maxage=30", "netlify-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=30" } });
  }

  if (!SLUG.test(slug) || slug === "constructor") return json({ error: "bad slug" }, 400); // "constructor" would collide with a built-in property wherever players are keyed by slug

  if (req.method === "GET") {
    const existing = (await store.get(slug, { type: "json" })) as Doc | null;
    if (!existing) return json({ error: "not found" }, 404);
    return json({ account: publicView(existing) });
  }

  if (req.method === "POST" && action === "reset") {
    // Admin only: remove a forgotten PIN; the player then logs in without one and sets a new PIN.
    const given = req.headers.get("x-admin-key") || "";
    // allowed with the maintenance key, or for the master admin / an admin signed in with their PIN
    let ok = false;
    if (given) { const g = await pinGate(req, context, "_admin", ADMIN_KEY_SHA256, await sha256(given)); if (g.ok) ok = true; else if (g.status === 429) return refused(g); }
    if (!ok) {
      const body = (await req.json().catch(() => ({}))) as { by?: string; auth?: string }; const by = String(body.by ?? "");
      if (SLUG.test(by) && by !== slug) {
        const r = await roleOf(by); const who = (await store.get(by, { type: "json" })) as Doc | null;
        // an account without a PIN proves nothing (anyone can act as it), and the master's PIN is not an admin's to remove
        if ((r === "master" || r === "admin") && who) { const g = await pinGate(req, context, by, who.pinHash, body.auth, { requirePin: true }); if (g.ok) ok = (await roleOf(slug)) !== "master"; else if (g.status === 429) return refused(g); }
      }
    }
    if (!ok) return json({ error: "forbidden" }, 403);
    let found = true;
    const doc = await cas<Doc>(store, slug, (cur) => { if (!cur) { found = false; return undefined; } delete cur.pinHash; delete cur.claimHash; cur.updatedAt = Date.now(); return cur; }); // (and the device claim: the next save from the owner's game takes a new one)
    if (!found || !doc) return json({ error: "not found" }, 404);
    await later(context, accountsIndex.put(slug, publicView(doc)));
    return json({ ok: true, account: publicView(doc) });
  }

  if (req.method === "POST" && action === "login") {
    const existing = (await store.get(slug, { type: "json" })) as Doc | null;
    if (!existing) return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as { pinHash?: string };
    // wrong PINs are limited per address and account (and loosely per account), so a guesser cannot lock the owner out
    const bad = refused(await pinGate(req, context, slug, existing.pinHash, body.pinHash)); if (bad) return bad;
    const { wal, claimHash, ...acc } = existing; // (the day's wallet counters and the device claim stay on the server)
    return json({ account: acc });
  }

  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { doc?: unknown; auth?: string; basedOn?: number | null; claim?: string; w?: number } | null;
    const doc = clean(body?.doc, slug);
    if (typeof doc === "string") return json({ error: doc }, 400);
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await store.getWithMetadata(slug, { type: "json" });
      const existing = cur ? (cur.data as Doc) : null;
      if (existing) { const bad = refused(await pinGate(req, context, slug, existing.pinHash, body?.auth)); if (bad) return bad; }
      else if (attempt === 0) { // a new account: at most 10 an hour and 30 a day from one address
        const h = await hit("create/" + (await ipKey(req, context)), [[10, HOUR], [30, 24 * HOUR]]);
        if (!h.ok) return json({ error: "too many accounts", wait: h.wait }, 429);
      }
      // a tab that holds an older copy of the profile must not overwrite what another device saved since
      if (existing && body?.basedOn != null && existing.updatedAt && Number(body.basedOn) !== existing.updatedAt) return json({ error: "stale", account: ownerView(existing) }, 409);
      const next: Doc = { ...doc };
      if (existing && existing.pinHash && !next.pinHash) next.pinHash = existing.pinHash;
      if (existing && existing.created) next.created = existing.created as number;
      if (existing) next.invitedBy = (existing.invitedBy as string | undefined) ?? next.invitedBy;
      if (!existing && !next.created) next.created = Date.now();
      // a profile without a PIN belongs to the device that made it (or, for an older one, saved it first): that device
      // holds a claim, and only with it can the profile be given a PIN, so a stranger cannot lock the owner out
      let claim = "";
      if (existing && !existing.pinHash && existing.claimHash) {
        if (next.pinHash && (await sha256(String(body?.claim || ""))) !== existing.claimHash) return json({ error: "claim" }, 403);
        if (!next.pinHash) next.claimHash = existing.claimHash;
      } else if (!next.pinHash && !(existing && existing.pinHash) && body?.w) { claim = newClaim(); next.claimHash = await sha256(claim); } // (only a game that keeps it)
      // coins and things: what a save from the game may change (wallet.mts); anything over is cut and noted
      const cut = guardSave(existing, next, await ownersFor(existing, next));
      // two saves at the same moment: the second one sees the first (and its PIN) instead of silently replacing it
      const w = await store.setJSON(slug, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
      if (w.modified) { await later(context, accountsIndex.put(slug, publicView(next))); await later(context, tellInviter(slug, existing, next)); if (cut.length) await later(context, noteCut(slug, cut)); return json({ account: ownerView(next), ...(cut.length ? { cut } : {}), ...(claim ? { claim } : {}) }); }
    }
    return json({ error: "busy" }, 503);
  }

  if (req.method === "DELETE") {
    // Only a PIN-protected profile can be removed, and only with its PIN.
    const existing = (await store.get(slug, { type: "json" })) as Doc | null;
    if (!existing) return json({ ok: true });
    const body = (await req.json().catch(() => ({}))) as { auth?: string };
    const bad = refused(await pinGate(req, context, slug, existing.pinHash, body.auth, { requirePin: true })); if (bad) return bad;
    await store.delete(slug);
    await later(context, accountsIndex.put(slug, null));
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config: Config = {
  path: ["/api/accounts", "/api/accounts/:slug", "/api/accounts/:slug/:action"],
};
