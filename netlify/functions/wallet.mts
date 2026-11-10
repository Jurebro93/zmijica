// The server's side of Vijuga's coins and things (a module, not a function: it has no route, like guard.mts).
//  - CATALOG (netlify/lib/catalog.mjs, written from the built page by tools/catalog.mjs): what every item costs
//  - guardSave(): what a profile save from the game may change, per day (Zagreb time). Coins won (matches, the streak,
//    coins from boxes...) may come to EARN_CAP plus what was spent that day; new things must be paid for: their catalog
//    value has to be covered by coins spent that day (with room for discounts) plus FREE_VALUE (boxes, drops); and all
//    that was gained together, coins and things, at most EARN_CAP + FREE_VALUE + what was spent. Limited things only
//    while some are left. Anything over is dropped from the save and noted for the admin.
//  - bump(): a change made by the server itself (a gift collected, a fee or a bid taken): applied straight to the
//    account, with compare-and-swap, so it never goes through the game's save and never counts in those limits (coins
//    paid there buy nothing in the game's own saves).
import { getStore } from "@netlify/blobs";
import { accountsIndex, cas, publicView } from "./guard.mts";
import { CATALOG } from "../lib/catalog.mjs";

type Doc = Record<string, any>;
type Wallet = { d: string; e: number; s: number; v: number };

export const EARN_CAP = 20_000, FREE_VALUE = 8_000, DISCOUNT = 1.6, NEW_ACCOUNT_COINS = 1_500;
const cat = CATALOG as { items: Record<string, { p: number; k: string; l?: number }>; inv: Record<string, number> };
export const priceOf = (id: string) => cat.items[id]?.p || 0;
export const limitOf = (id: string) => cat.items[id]?.l || 0;
export const invPriceOf = (id: string) => (id in cat.inv ? cat.inv[id] : null);
export const isThing = (id: string) => !!cat.items[id];
export const zDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb" }).format(t);
const wallet = (d: Doc | null): Wallet => { const today = zDay(); const w = d && d.wal; return w && w.d === today ? { d: today, e: +w.e || 0, s: +w.s || 0, v: +w.v || 0 } : { d: today, e: 0, s: 0, v: 0 }; };

// limited things that a save would add: how many other players own each (from the public index; read only when needed)
export async function ownersFor(old: Doc | null, next: Doc) {
  const had = new Set((old && old.owned) || []);
  const wanted = ((next.owned || []) as string[]).filter((id) => !had.has(id) && limitOf(id));
  if (!wanted.length) return () => 0;
  const idx = await accountsIndex.read();
  const n: Record<string, number> = {};
  for (const a of Object.values(idx)) if (a && a.slug !== next.slug && Array.isArray(a.owned)) for (const id of wanted) if ((a.owned as string[]).includes(id)) n[id] = (n[id] || 0) + 1;
  return (id: string) => n[id] || 0;
}

// a thing taken out of a save is taken off the snake too
function unwear(d: Doc, gone: Set<string>) {
  const eq = d.eq && typeof d.eq === "object" ? d.eq : null; if (!eq) return;
  for (const k of Object.keys(eq)) if (typeof eq[k] === "string" && gone.has(eq[k])) eq[k] = k === "skin" ? "sk_none" : k === "badge" ? "bd_none" : "";
  if (Array.isArray(eq.bx)) eq.bx = eq.bx.filter((id: string) => !gone.has(id));
}
// changes `next` in place; returns notes about what was cut (empty when the save was all right)
export function guardSave(old: Doc | null, next: Doc, ownersOf: (id: string) => number): string[] {
  const notes: string[] = [], w = wallet(old);
  next.owned = Array.isArray(next.owned) ? next.owned : [];
  if (!old) { // a new account: the starting coins and nothing bought
    if ((next.coins || 0) > NEW_ACCOUNT_COINS) { notes.push(`new account coins ${next.coins} -> ${NEW_ACCOUNT_COINS}`); next.coins = NEW_ACCOUNT_COINS; }
    const dropped = new Set<string>(next.owned.filter((id: string) => !id.startsWith("x_") && priceOf(id)));
    if (dropped.size) { next.owned = next.owned.filter((id: string) => !dropped.has(id)); notes.push("new account: bought things dropped"); unwear(next, dropped); }
    if (next.inv && Object.keys(next.inv).length) { next.inv = {}; notes.push("new account: inventory dropped"); }
    next.wal = w; return notes;
  }
  const delta = (Number(next.coins) || 0) - (Number(old.coins) || 0);
  const total = () => EARN_CAP + FREE_VALUE + w.s - w.e - w.v; // all that may still be gained today
  if (delta > 0) { const ok = Math.min(delta, Math.max(0, Math.min(EARN_CAP + w.s - w.e, total()))); if (ok < delta) notes.push(`coins +${delta} capped to +${ok} (earned ${w.e}, spent ${w.s} today)`); next.coins = (Number(old.coins) || 0) + ok; w.e += ok; }
  else w.s += -delta;
  const room = () => Math.min(w.s * DISCOUNT + FREE_VALUE - w.v, total());
  const had = new Set(old.owned || []), cut = new Set<string>();
  for (const id of next.owned as string[]) {
    if (had.has(id) || id.startsWith("x_")) continue;
    const p = priceOf(id); if (!p) continue;
    const l = limitOf(id); if (l && ownersOf(id) >= l) { cut.add(id); notes.push(`${id}: none left`); continue; }
    if (p > room()) { cut.add(id); notes.push(`${id}: not paid (${p} > ${Math.round(room())})`); continue; }
    w.v += p;
  }
  if (cut.size) { next.owned = next.owned.filter((id: string) => !cut.has(id)); unwear(next, cut); }
  const inv: Record<string, number> = { ...(next.inv || {}) }, oinv = old.inv || {};
  for (const k of Object.keys(inv)) {
    const add = (Number(inv[k]) || 0) - (Number(oinv[k]) || 0); if (add <= 0) continue;
    const p = invPriceOf(k) ?? 100; let ok = add; while (ok > 0 && p * ok > room()) ok--;
    if (ok < add) { notes.push(`${k}: +${add} capped to +${ok}`); inv[k] = (Number(oinv[k]) || 0) + ok; if (!inv[k]) delete inv[k]; }
    w.v += p * ok;
  }
  next.inv = inv; next.wal = w;
  return notes;
}

const accounts = () => getStore({ name: "vijuga-accounts", consistency: "strong" });
// a change the server makes to an account; mutate returns false to give up (e.g. not enough coins). Returns the new
// account with _prev (its revision before this change; the game moves its own revision along only from that one),
// or null (no account / given up).
export async function bump(slug: string, mutate: (d: Doc) => boolean | void): Promise<Doc | null> {
  let gaveUp = false, prev: unknown = null;
  const out = await cas<Doc>(accounts(), slug, (cur) => {
    gaveUp = false; if (!cur) return undefined; prev = cur.updatedAt ?? null;
    const d: Doc = { ...cur, owned: [...(cur.owned || [])], inv: { ...(cur.inv || {}) } };
    if (mutate(d) === false) { gaveUp = true; return undefined; }
    d.coins = Math.max(0, Math.floor(Number(d.coins) || 0));
    d.updatedAt = Math.max(Date.now(), (Number(cur.updatedAt) || 0) + 1); return d;
  });
  if (!out || gaveUp) return null;
  await accountsIndex.put(slug, publicView(out)).catch(() => {});
  return Object.assign(out, { _prev: prev });
}
// a gift being collected: coins, a prank / shield, or a thing (a thing already owned turns into its price in coins)
export function applyGift(d: Doc, item: string): Record<string, unknown> {
  if (/^coins:\d+$/.test(item)) { const n = Math.min(1_000_000, Number(item.slice(6))); d.coins = (Number(d.coins) || 0) + n; return { coins: n }; }
  if (invPriceOf(item) !== null) { d.inv[item] = Math.min(999, (Number(d.inv[item]) || 0) + 1); return { inv: item }; }
  if (isThing(item)) { if (!d.owned.includes(item)) { d.owned.push(item); return { item }; } const n = priceOf(item); d.coins = (Number(d.coins) || 0) + n; return { coins: n, had: item }; }
  return {};
}
// what was cut from a save, kept for the admin (one small blob per player and day)
export async function noteCut(slug: string, notes: string[]) {
  if (!notes.length) return;
  const s = getStore({ name: "vijuga-wallet-notes", consistency: "strong" });
  await cas<{ notes: string[] }>(s, `${zDay()}/${slug}`, (cur) => ({ notes: [...((cur && cur.notes) || []), ...notes.map((n) => new Date().toISOString().slice(11, 19) + " " + n)].slice(-50) })).catch(() => {});
}
