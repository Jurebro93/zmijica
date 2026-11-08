// Auction house for Vijuga's limited and unique items.
// The seller's item leaves their profile when listed; bids lock the bidder's coins (in the game) and an outbid
// bidder gets them back as a coin gift. A sale ends when the seller accepts, someone pays the buy-now price,
// or after 5 days (highest bid wins; with no bids the item goes back). 5 % of each sale leaves the game.
// GET  /api/auction                      -> { active, done, stats }
// POST /api/auction {slug, auth, item, start, buyNow}  -> list an item (seller must own it)
// POST /api/auction/:id/:action {slug, auth, amount}   -> bid | accept | cancel
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, ITEM = /^[a-z]{2}_[a-z0-9_]{2,20}$/;
const DAYS = 5, FEE = 0.05;

type Bid = { slug: string; name: string; amount: number; at: number };
type Lot = { id: string; item: string; seller: string; sellerName: string; start: number; buyNow: number; created: number; ends: number; bids: Bid[]; status: "active" | "sold" | "returned" | "cancelled"; price?: number; buyer?: string; buyerName?: string; closed?: number };

const store = () => getStore({ name: "vijuga-auctions", consistency: "strong" });
async function account(slug: string) { return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null; }
async function authed(slug: string, auth: unknown) { if (!SLUG.test(slug)) return null; const a = await account(slug); if (!a || (a.pinHash && a.pinHash !== auth)) return null; return a; }
async function gift(to: string, item: string, why: string) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${to}/${id}`, { id, from: "aukcija", fromName: why, item, at: Date.now() });
}
const top = (l: Lot) => l.bids[l.bids.length - 1] || null;
const minBid = (l: Lot) => { const t = top(l); return t ? Math.ceil(t.amount * 1.05 + 1) : l.start; };

async function sell(l: Lot, b: Bid) {
  l.status = "sold"; l.price = b.amount; l.buyer = b.slug; l.buyerName = b.name; l.closed = Date.now();
  await gift(b.slug, l.item, `Aukcija: kupio si od ${l.sellerName}`);
  await gift(l.seller, "coins:" + Math.floor(b.amount * (1 - FEE)), `Aukcija: prodano ${b.name} (−5 % provizija)`);
}
async function sweep(lots: Lot[]) {
  const s = store();
  for (const l of lots) if (l.status === "active" && l.ends < Date.now()) {
    const b = top(l);
    if (b) await sell(l, b); else { l.status = "returned"; l.closed = Date.now(); await gift(l.seller, l.item, "Aukcija istekla bez ponuda: stvar ti je vraćena"); }
    await s.setJSON(l.id, l);
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const s = store();
  const load = async () => { const { blobs } = await s.list(); return ((await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))) as Lot[]).filter(Boolean); };
  if (req.method === "GET") {
    const lots = await load(); await sweep(lots);
    const done = lots.filter((l) => l.status !== "active").sort((a, b) => (b.closed || 0) - (a.closed || 0)).slice(0, 30);
    const stats: Record<string, { sales: number; avg: number; last: number }> = {};
    for (const l of lots) if (l.status === "sold" && l.price) { const x = (stats[l.item] ||= { sales: 0, avg: 0, last: 0 }); x.avg = Math.round((x.avg * x.sales + l.price) / (x.sales + 1)); x.sales++; x.last = l.price; }
    return json({ active: lots.filter((l) => l.status === "active").sort((a, b) => a.ends - b.ends), done, stats });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""); const acc = await authed(slug, b.auth); if (!acc) return json({ error: "auth" }, 403);
  const name = String(acc.name ?? slug).slice(0, 14);
  const id = context.params.id, action = context.params.action;

  if (!id) {
    const item = String(b.item ?? ""); if (!ITEM.test(item) || item.startsWith("co")) return json({ error: "bad item" }, 400);
    if (!Array.isArray(acc.owned) || !(acc.owned as string[]).includes(item)) return json({ error: "not owned" }, 409);
    const lots = await load(); if (lots.some((l) => l.status === "active" && l.item === item && l.seller === slug)) return json({ error: "already listed" }, 409);
    const start = Math.max(10, Math.min(1_000_000, Math.floor(Number(b.start) || 0)));
    const buyNow = Math.floor(Number(b.buyNow) || 0); const bn = buyNow > start ? Math.min(1_000_000, buyNow) : 0;
    const l: Lot = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), item, seller: slug, sellerName: name, start, buyNow: bn, created: Date.now(), ends: Date.now() + DAYS * 86400000, bids: [], status: "active" };
    await s.setJSON(l.id, l); return json({ lot: l });
  }
  const l = (await s.get(id, { type: "json" })) as Lot | null; if (!l) return json({ error: "not found" }, 404);
  await sweep([l]); if (l.status !== "active") return json({ error: "closed", lot: l }, 409);
  if (action === "bid") {
    if (slug === l.seller) return json({ error: "own lot" }, 409);
    const amount = Math.floor(Number(b.amount) || 0);
    const buyNowHit = l.buyNow && amount >= l.buyNow;
    if (!buyNowHit && amount < minBid(l)) return json({ error: "too low", min: minBid(l) }, 409);
    const prev = top(l);
    const bid: Bid = { slug, name, amount: buyNowHit ? l.buyNow : amount, at: Date.now() };
    l.bids.push(bid); if (l.bids.length > 50) l.bids = l.bids.slice(-50);
    if (prev) await gift(prev.slug, "coins:" + prev.amount, `Aukcija: nadmašen si (${name} nudi ${bid.amount}), ponuda ti je vraćena`);
    if (buyNowHit) await sell(l, bid);
    await s.setJSON(l.id, l); return json({ lot: l, paid: bid.amount });
  }
  if (action === "accept") {
    if (slug !== l.seller) return json({ error: "not seller" }, 403);
    const t = top(l); if (!t) return json({ error: "no bids" }, 409);
    await sell(l, t); await s.setJSON(l.id, l); return json({ lot: l });
  }
  if (action === "cancel") {
    if (slug !== l.seller) return json({ error: "not seller" }, 403);
    if (l.bids.length) return json({ error: "has bids" }, 409);
    l.status = "cancelled"; l.closed = Date.now(); await gift(l.seller, l.item, "Aukcija povučena: stvar ti je vraćena");
    await s.setJSON(l.id, l); return json({ lot: l });
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/auction", "/api/auction/:id/:action"] };
