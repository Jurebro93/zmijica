// Auction house for Vijuga's limited and unique items.
// The seller's item leaves their profile when listed; bids lock the bidder's coins (in the game) and an outbid
// bidder gets them back as a coin gift. A sale ends when the seller accepts, someone pays the buy-now price,
// or after 5 days (highest bid wins; with no bids the item goes back). 5 % of each sale leaves the game.
// GET  /api/auction                      -> { active, done, stats, wants }
// POST /api/auction {slug, auth, item, start, buyNow}  -> list an item (seller must own it)
// POST /api/auction/:id/:action {slug, auth, amount}   -> bid | accept | cancel
// Buy requests ("zahtjev za kupnju"): anyone asks for an item at a price of their choice; the coins are locked in the game;
// anyone who owns that item can sell it to them at once. A request lasts 7 days; withdrawn or expired, the coins go back.
// POST /api/auction/want/new {slug, auth, item, price}  -> open a request
// POST /api/auction/:wantId/sell | withdraw {slug, auth}
// Every amount must be a finite whole number up to 1 000 000 (400 "bad amount" / "bad price" otherwise). Every change of
// a lot or a request is a compare-and-swap: only the request whose write wins moves coins or items, so two bids at once
// can neither lose a bid nor refund the outbid player twice. Lots and requests closed more than 30 days ago are removed;
// their sales stay in the price statistics (an archive blob).
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { authed, cas, later } from "./guard.mts";
import { bump, owns, transit } from "./wallet.mts";
import { treasury } from "./roles.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const ITEM = /^[a-z]{2}_[a-z0-9_]{2,20}$/;
const DAYS = 5, FEE = 0.05, MAX = 1_000_000, KEEP_MS = 30 * 86400000;
// a whole number of coins, or NaN for anything that is not a finite number ("Infinity", "1e999", "abc", objects)
const coins = (v: unknown) => { const x = typeof v === "number" || typeof v === "string" ? Number(v) : NaN; return Number.isFinite(x) ? Math.floor(x) : NaN; };

type Bid = { slug: string; name: string; amount: number; at: number };
type Lot = { id: string; item: string; seller: string; sellerName: string; start: number; buyNow: number; created: number; ends: number; bids: Bid[]; status: "active" | "sold" | "returned" | "cancelled"; price?: number; buyer?: string; buyerName?: string; closed?: number };

const store = () => getStore({ name: "vijuga-auctions", consistency: "strong" });
type Want = { id: string; item: string; buyer: string; buyerName: string; price: number; created: number; ends: number; status: "open" | "filled" | "withdrawn" | "expired"; seller?: string; sellerName?: string; closed?: number };
const wantStore = () => getStore({ name: "vijuga-auction-wants", consistency: "strong" });
const WANT_DAYS = 7, WANT_MAX = 5;
async function loadWants() { const s = wantStore(); const { blobs } = await s.list(); return ((await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))) as Want[]).filter(Boolean); }
// one state change of a request, safe against two at once (two sellers, a seller and the expiry): only the write that
// still sees the request open wins, and only the winner moves coins or the item
async function closeWant(id: string, patch: Partial<Want>, check: (w: Want) => string | null): Promise<{ want?: Want; error?: string }> {
  const s = wantStore(); const cur = await s.getWithMetadata(id, { type: "json" }); if (!cur) return { error: "not found" };
  const w = cur.data as Want; if (w.status !== "open") return { error: "closed", want: w };
  const bad = check(w); if (bad) return { error: bad, want: w };
  const nw = { ...w, ...patch, closed: Date.now() } as Want; const r = await s.setJSON(id, nw, { onlyIfMatch: cur.etag });
  return r.modified ? { want: nw } : { error: "closed" };
}
async function sweepWants(ws: Want[]) {
  for (const w of ws) if (w.status === "open" && w.ends < Date.now()) {
    const r = await closeWant(w.id, { status: "expired" }, () => null);
    if (r.want) { Object.assign(w, r.want); await gift(w.buyer, "coins:" + w.price, "Zahtjev za kupnju je istekao: zlatnici su ti vraćeni"); }
  }
}
async function gift(to: string, item: string, why: string) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await transit(item, `g/${to}/${id}`, true); // (a limited thing: still counted while it waits as a gift)
  await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${to}/${id}`, { id, from: "aukcija", fromName: why, item, at: Date.now() });
}
const top = (l: Lot) => l.bids[l.bids.length - 1] || null;
const minBid = (l: Lot) => { const t = top(l); return t ? Math.ceil(t.amount * 1.05 + 1) : l.start; };

// a sale is two steps: the state change (inside a compare-and-swap) and, once that write has won, the gifts
function markSold(l: Lot, b: Bid) { l.status = "sold"; l.price = b.amount; l.buyer = b.slug; l.buyerName = b.name; l.closed = Date.now(); }
async function paySale(l: Lot, b: Bid) {
  await gift(b.slug, l.item, `Aukcija: kupio si od ${l.sellerName}`); await transit(l.item, `lot/${l.id}`, false);
  await gift(l.seller, "coins:" + Math.floor(b.amount * (1 - FEE)), `Aukcija: prodano ${b.name} (−5 % provizija)`);
  await treasury(b.amount - Math.floor(b.amount * (1 - FEE))).catch(() => {}); // the commission fills the tournament treasury
}
// change one lot; fn returns false to write nothing. Returns the lot as it is after the call (null: no such lot).
const updateLot = (id: string, fn: (l: Lot) => boolean | void) => cas<Lot>(store(), id, (cur) => (cur && fn(cur) !== false ? cur : undefined));
// lots past their end: every visitor's request sweeps, often several in the same second; only the request whose write
// closes the lot pays it out
async function sweep(lots: Lot[]) {
  for (let i = 0; i < lots.length; i++) {
    const l0 = lots[i]; if (l0.status !== "active" || l0.ends >= Date.now()) continue;
    const o: { won: Bid | null; closed: boolean } = { won: null, closed: false };
    const l = await updateLot(l0.id, (l) => {
      o.won = null; o.closed = false;
      if (l.status !== "active" || l.ends >= Date.now()) return false;
      o.won = top(l); if (o.won) markSold(l, o.won); else { l.status = "returned"; l.closed = Date.now(); }
      o.closed = true;
    });
    if (!l) continue;
    lots[i] = l;
    if (o.closed) { if (o.won) await paySale(l, o.won); else { await gift(l.seller, l.item, "Aukcija istekla bez ponuda: stvar ti je vraćena"); await transit(l.item, `lot/${l.id}`, false); } }
  }
}

// ---- old lots and requests leave; their sales are kept in an archive so the price statistics do not change
type Stat = { sales: number; avg: number; last: number };
type Archive = { stats: Record<string, Stat>; seen: Record<string, number> };
const archive = () => getStore({ name: "vijuga-auction-archive", consistency: "strong" });
const fold = (stats: Record<string, Stat>, sales: { item: string; price: number }[]) => { for (const x0 of sales) { const x = (stats[x0.item] ||= { sales: 0, avg: 0, last: 0 }); x.avg = Math.round((x.avg * x.sales + x0.price) / (x.sales + 1)); x.sales++; x.last = x0.price; } };
async function purge(lots: Lot[], wants: Want[]) {
  const cut = Date.now() - KEEP_MS;
  const old = [...lots.filter((l) => l.status !== "active" && (l.closed || l.created) < cut).map((l) => ({ id: l.id, closed: l.closed || l.created, sale: l.status === "sold" && l.price ? { item: l.item, price: l.price } : null, want: false })),
    ...wants.filter((w) => w.status !== "open" && (w.closed || w.created) < cut).map((w) => ({ id: w.id, closed: w.closed || w.created, sale: w.status === "filled" ? { item: w.item, price: w.price } : null, want: true }))]
    .sort((a, b) => a.closed - b.closed).slice(0, 25);
  if (!old.length) return;
  await cas<Archive>(archive(), "stats", (cur) => {
    const a = cur || { stats: {}, seen: {} };
    const fresh = old.filter((x) => !(x.id in a.seen));
    if (!fresh.length) return undefined;
    fold(a.stats, fresh.filter((x) => x.sale).map((x) => x.sale!));
    for (const x of fresh) a.seen[x.id] = x.closed;
    for (const k of Object.keys(a.seen)) if (a.seen[k] < cut - 60 * 86400000) delete a.seen[k]; // long gone: cannot come back
    return a;
  });
  await Promise.all(old.map((x) => (x.want ? wantStore() : store()).delete(x.id)));
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const s = store();
  const load = async () => { const { blobs } = await s.list(); return ((await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))) as Lot[]).filter(Boolean); };
  if (req.method === "GET") {
    const [lots, wants, arch] = await Promise.all([load(), loadWants(), archive().get("stats", { type: "json" }) as Promise<Archive | null>]);
    await sweep(lots); await sweepWants(wants);
    const seen = arch?.seen || {}, liveLots = lots.filter((l) => !(l.id in seen)), liveWants = wants.filter((w) => !(w.id in seen));
    const done = liveLots.filter((l) => l.status !== "active").sort((a, b) => (b.closed || 0) - (a.closed || 0)).slice(0, 30);
    // a filled request is a sale too; archived sales come first (they are all older)
    const stats: Record<string, Stat> = JSON.parse(JSON.stringify(arch?.stats || {}));
    fold(stats, [...liveLots.filter((l) => l.status === "sold" && l.price).map((l) => ({ item: l.item, price: l.price!, closed: l.closed || 0 })), ...liveWants.filter((w) => w.status === "filled").map((w) => ({ item: w.item, price: w.price, closed: w.closed || 0 }))].sort((a, b) => a.closed - b.closed));
    const filled = liveWants.filter((w) => w.status === "filled").map((w) => ({ id: w.id, item: w.item, seller: w.seller, sellerName: w.sellerName, buyer: w.buyer, buyerName: w.buyerName, price: w.price, status: "sold", closed: w.closed, want: true }));
    const done2 = [...done, ...filled].sort((a, b) => (b.closed || 0) - (a.closed || 0)).slice(0, 30);
    await later(context, purge(liveLots, liveWants));
    return json({ active: liveLots.filter((l) => l.status === "active").sort((a, b) => a.ends - b.ends), done: done2, stats, wants: liveWants.filter((w) => w.status === "open").sort((a, b) => b.price - a.price) });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""); const { acc, gate } = await authed(req, context, slug, b.auth);
  if (!acc || !gate.ok) return !gate.ok && gate.status === 429 ? json({ error: gate.error, wait: gate.wait }, 429) : json({ error: "auth" }, 403);
  if (!b.w) return json({ error: "update" }, 409); // a page from before the server wallet would count coins twice
  if (!(await owns(acc, b.claim))) return json({ error: "pin needed" }, 403); // without a PIN: only the owner's device
  const name = String(acc.name ?? slug).slice(0, 14);
  const id = context.params.id, action = context.params.action;

  if (id === "want" && action === "new") {
    const item = String(b.item ?? ""); if (!ITEM.test(item) || item.startsWith("co")) return json({ error: "bad item" }, 400);
    if (Array.isArray(acc.owned) && (acc.owned as string[]).includes(item)) return json({ error: "already own" }, 409);
    const price = coins(b.price); if (!(price >= 10 && price <= MAX)) return json({ error: "bad price" }, 400);
    const open = (await loadWants()).filter((w) => w.status === "open" && w.buyer === slug);
    if (open.some((w) => w.item === item)) return json({ error: "already wanted" }, 409);
    if (open.length >= WANT_MAX) return json({ error: "too many wants" }, 409);
    const w: Want = { id: "want-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), item, buyer: slug, buyerName: name, price, created: Date.now(), ends: Date.now() + WANT_DAYS * 86400000, status: "open" };
    const paidAcc = await bump(slug, (d) => { if ((Number(d.coins) || 0) < price) return false; d.coins -= price; }); if (!paidAcc) return json({ error: "not enough coins" }, 409);
    const r = await wantStore().setJSON(w.id, w, { onlyIfNew: true }).catch(() => ({ modified: false })); if (!r.modified) { await bump(slug, (d) => { d.coins += price; }); return json({ error: "busy" }, 503); }
    return json({ want: w, paid: price, charged: price, rev: paidAcc.updatedAt, prev: paidAcc._prev });
  }
  if (id && id.startsWith("want-")) {
    if (action === "sell") {
      const w0 = (await wantStore().get(id, { type: "json" })) as Want | null; if (!w0) return json({ error: "not found" }, 404);
      if (w0.status !== "open" || w0.ends < Date.now()) return json({ error: "closed", want: w0 }, 409);
      if (slug === w0.buyer) return json({ error: "own want", want: w0 }, 409);
      // the thing leaves the seller's account first: of two sales of one copy at the same moment only one gets it
      const took = await bump(slug, (d) => { if (!d.owned.includes(w0.item)) return false; d.owned = d.owned.filter((x: string) => x !== w0.item); });
      if (!took) return json({ error: "not owned" }, 409);
      const back = () => bump(slug, (d) => { if (!d.owned.includes(w0.item)) d.owned.push(w0.item); });
      let r: { want?: Want; error?: string };
      try { r = await closeWant(id, { status: "filled", seller: slug, sellerName: name }, (w) => w.ends < Date.now() ? "closed" : slug === w.buyer ? "own want" : null); }
      catch (e) { await back(); throw e; }
      if (!r.want || r.error) { await back(); return json({ error: r.error, want: r.want }, r.error === "not found" ? 404 : 409); }
      await gift(r.want.buyer, r.want.item, `Zahtjev za kupnju: ${name} ti je prodao`);
      await gift(slug, "coins:" + Math.floor(r.want.price * (1 - FEE)), `Zahtjev za kupnju: prodao si ${r.want.buyerName} (−5 % provizija)`);
      await treasury(r.want.price - Math.floor(r.want.price * (1 - FEE))).catch(() => {});
      return json({ want: r.want, took: r.want.item, rev: took ? took.updatedAt : null, prev: took ? took._prev : null });
    }
    if (action === "withdraw") {
      const r = await closeWant(id, { status: "withdrawn" }, (w) => slug !== w.buyer ? "not buyer" : null);
      if (!r.want || r.error) return json({ error: r.error, want: r.want }, r.error === "not found" ? 404 : r.error === "not buyer" ? 403 : 409);
      await gift(slug, "coins:" + r.want.price, "Zahtjev za kupnju povučen: zlatnici su ti vraćeni");
      return json({ want: r.want });
    }
    return json({ error: "unknown action" }, 404);
  }

  if (!id) {
    const item = String(b.item ?? ""); if (!ITEM.test(item) || item.startsWith("co")) return json({ error: "bad item" }, 400);
    if (!Array.isArray(acc.owned) || !(acc.owned as string[]).includes(item)) return json({ error: "not owned" }, 409);
    // as before: missing or not a number counts as 0 and the start is at least 10; an infinite amount is refused
    const start0 = coins(b.start ?? 0), buyNow0 = coins(b.buyNow ?? 0);
    if ([b.start, b.buyNow].some((v) => Math.abs(Number(v)) === Infinity)) return json({ error: "bad amount" }, 400);
    const lots = await load(); if (lots.some((l) => l.status === "active" && l.item === item && l.seller === slug)) return json({ error: "already listed" }, 409);
    const start = Math.max(10, Math.min(MAX, start0 || 0)), bn = (buyNow0 || 0) > start ? Math.min(MAX, buyNow0) : 0;
    const l: Lot = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), item, seller: slug, sellerName: name, start, buyNow: bn, created: Date.now(), ends: Date.now() + DAYS * 86400000, bids: [], status: "active" };
    // the thing leaves the seller's account here, while it is on sale (it comes back as a gift if nobody buys it)
    const took = await bump(slug, (d) => { if (!d.owned.includes(item)) return false; d.owned = d.owned.filter((x: string) => x !== item); }); if (!took) return json({ error: "not owned" }, 409);
    await transit(item, `lot/${l.id}`, true);
    const w = await s.setJSON(l.id, l, { onlyIfNew: true }).catch(() => ({ modified: false }));
    if (!w.modified) { await bump(slug, (d) => { if (!d.owned.includes(item)) d.owned.push(item); }); await transit(item, `lot/${l.id}`, false); return json({ error: "busy" }, 503); }
    return json({ lot: l, took: item, rev: took.updatedAt, prev: took._prev });
  }
  const l0 = (await s.get(id, { type: "json" })) as Lot | null; if (!l0) return json({ error: "not found" }, 404);
  const one = [l0]; await sweep(one); if (one[0].status !== "active") return json({ error: "closed", lot: one[0] }, 409);
  type R = { fail?: [Record<string, unknown>, number]; prev?: Bid | null; sold?: Bid | null; bid?: Bid; ok?: boolean };
  const r: R = {};
  const change = (fn: (l: Lot) => boolean | void) => updateLot(id, (l) => { r.fail = undefined; r.prev = null; r.sold = null; r.ok = false; if (l.status !== "active" || l.ends < Date.now()) { r.fail = [{ error: "closed", lot: l }, 409]; return false; } return fn(l); });
  if (action === "bid") {
    if (slug === l0.seller) return json({ error: "own lot" }, 409);
    if (Array.isArray(acc.owned) && (acc.owned as string[]).includes(l0.item)) return json({ error: "already own" }, 409);
    const amount = coins(b.amount); if (!(amount >= 1 && amount <= MAX)) return json({ error: "bad amount" }, 400);
    // the bid is taken from the account first; what the bid did not use (refused, or a lower buy-now price) goes back
    const held = await bump(slug, (d) => { if ((Number(d.coins) || 0) < amount) return false; d.coins -= amount; }); if (!held) return json({ error: "not enough coins" }, 409);
    let rev: unknown = held.updatedAt; const prev = held._prev;
    const giveBack = async (n: number) => {
      if (!(n > 0)) return;
      let a3 = null; for (let i = 0; i < 3 && !a3; i++) a3 = await bump(slug, (d) => { d.coins += n; }).catch(() => null);
      if (!a3) { await gift(slug, "coins:" + n, "Aukcija: neiskorišteni dio ponude"); rev = null; return; } // (by gift, if the account would not take it)
      rev = a3._prev === rev ? a3.updatedAt : null; // something else changed the account in between: the game reloads it instead
    };
    let l: Lot | null;
    try {
    l = await change((l) => {
      const buyNowHit = !!l.buyNow && amount >= l.buyNow;
      if (!buyNowHit && amount < minBid(l)) { r.fail = [{ error: "too low", min: minBid(l) }, 409]; return false; }
      r.prev = top(l);
      r.bid = { slug, name, amount: buyNowHit ? l.buyNow : amount, at: Date.now() };
      l.bids.push(r.bid); if (l.bids.length > 50) l.bids = l.bids.slice(-50);
      if (buyNowHit) { markSold(l, r.bid); r.sold = r.bid; }
    });
    } catch (e) { await giveBack(amount); throw e; }
    if (r.fail) { await giveBack(amount); return json(r.fail[0], r.fail[1]); }
    if (!l || !r.bid) { await giveBack(amount); return json({ error: "not found" }, 404); }
    await giveBack(amount - r.bid.amount);
    // only now, with the bid written, the outbid player gets the coins back (once: a second bid at the same moment saw this one)
    if (r.prev) await gift(r.prev.slug, "coins:" + r.prev.amount, `Aukcija: nadmašen si (${name} nudi ${r.bid.amount}), ponuda ti je vraćena`);
    if (r.sold) await paySale(l, r.sold);
    return json({ lot: l, paid: r.bid.amount, charged: r.bid.amount, rev, prev });
  }
  if (action === "accept") {
    if (slug !== l0.seller) return json({ error: "not seller" }, 403);
    const l = await change((l) => { const t = top(l); if (!t) { r.fail = [{ error: "no bids" }, 409]; return false; } markSold(l, t); r.sold = t; });
    if (r.fail) return json(r.fail[0], r.fail[1]);
    if (!l) return json({ error: "not found" }, 404);
    if (r.sold) await paySale(l, r.sold);
    return json({ lot: l });
  }
  if (action === "cancel") {
    if (slug !== l0.seller) return json({ error: "not seller" }, 403);
    const l = await change((l) => { if (l.bids.length) { r.fail = [{ error: "has bids" }, 409]; return false; } l.status = "cancelled"; l.closed = Date.now(); r.ok = true; });
    if (r.fail) return json(r.fail[0], r.fail[1]);
    if (!l) return json({ error: "not found" }, 404);
    if (r.ok) { await gift(l.seller, l.item, "Aukcija povučena: stvar ti je vraćena"); await transit(l.item, `lot/${l.id}`, false); }
    return json({ lot: l });
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/auction", "/api/auction/:id/:action"] };
