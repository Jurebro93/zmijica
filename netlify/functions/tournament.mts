// Coin tournaments for Vijuga.
// Players pay the entry fee from their own coins (in the game); prizes and refunds arrive as gifts ("coins:N").
// Format: 3 qualifying rounds at tables of up to 5 (points 10/6/3/1/0), then a final of the top 5. Pot: 60/30/10 %.
// GET  /api/tournament              -> recent tournaments
// GET  /api/tournament/:id          -> one tournament
// POST /api/tournament              {slug, auth, name, start, max, bonus}   (admin) create
// POST /api/tournament/:id/:action  {slug, auth, ...}  join | leave | start (admin) | bonus (admin) | cancel (admin) | result |
//                                   confirm (admin) | paidout (admin) | view
// Real-money tournaments: a fixed stake (eur) or a stake each player chooses between stake.min and stake.max, paid
// through Stripe (pay.mts); at least 6 players (2 with a sandbox key: demo money); leaving or a cancelled tournament
// refunds the payment. The pot is shared by stake ("side pots"): from each player you can win at most what you staked
// yourself. Every stake level is a pot shared 50/30/20 by the best three of those who staked that much; a part nobody
// matched goes back. Winnings are paid out by the organiser and marked here; unmatched parts are refunded to the card.
//
// Table results: every player at a table reports the order ({round, table, ranking}), not earlier than 45 s after the
// round started. A coin table takes the first report. A money table closes when a strict majority of its players sent
// the same order, or when an admin (master/admin, not seated there) confirms one of the reports:
//   POST /api/tournament/:id/confirm {slug, auth, round, table, reportOf}
// An admin who is not at a table and sends "result" closes it without a match, in seat order: any time for coins; for
// money only when nobody reported and the round has run for 20 minutes. Who reported what is shown to admins only
// (every answer to an admin with a PIN, or POST .../view); everybody else sees `reported: [slugs]` per table.
//
// Every change goes through updateTour() (compare-and-swap, retried), so two requests at once (a Stripe webhook and a
// player leaving) can never drop a paid player. Refunds happen only after the write that removed the player: they are
// recorded per player (paid[slug].refund) and retried on later requests until Stripe confirms. A money tournament that is
// called off is "cancelling" until every entry is back on its card, then "cancelled".
// Admin actions need an account with a PIN ("pin needed").
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { roleOf, treasury } from "./roles.mts";
import { refund, stripeOn, stripeTest } from "./stripe.mts";
import { authed, cas } from "./guard.mts";
import { bump, owns } from "./wallet.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const FEE = 500, ROUNDS = 3, TABLE = 5, POINTS = [10, 6, 3, 1, 0], SPLIT = [0.6, 0.3, 0.1];
const MIN_MONEY = 6, MIN_DEMO = 2, SPLIT_EUR = [0.5, 0.3, 0.2], EUR_MAX = 100;
export const REPORT_AFTER = 45_000, FORFEIT_AFTER = 20 * 60_000;
// a refund that failed is tried again after 30 s, 1 min, 2 min ... at most every 15 min (an admin's cancel tries at once)
const retryGap = (tries: number) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, tries - 1));

type Table = { id: number; players: string[]; result: string[] | null; reports?: Record<string, string[]>; at?: number; by?: string };
type Pending = { why: string; tries: number; last?: number; err?: string };
// refund: a full refund owed (pending until `refunded`); backDue: an unmatched part owed (pending until `back`)
type Paid = { eur: number; pi: string; session: string; at: number; refunded?: number; refund?: Pending; back?: number; backDue?: number; backTry?: Pending };
export type Tour = {
  id: string; name: string; start: number; max: number; fee: number; bonus: number; created: number;
  status: "open" | "running" | "final" | "done" | "cancelling" | "cancelled";
  players: { slug: string; name: string }[]; rounds: { k: number; at?: number; tables: Table[] }[];
  points: Record<string, number>; final: Table | null; winners: { slug: string; name: string; prize: number }[];
  eur?: number; stake?: { min: number; max: number }; min?: number; test?: boolean; paid?: Record<string, Paid>;
  payouts?: { slug: string; name: string; place: number; eur: number; paid: boolean; at?: number }[];
};

const tours = () => getStore({ name: "vijuga-tournaments", consistency: "strong" });
// the one way a tournament is changed: fn edits it in place (return false to write nothing); it may run more than once
export async function updateTour(id: string, fn: (t: Tour) => boolean | void) {
  return cas<Tour>(tours(), id, (cur) => (cur && fn(cur) !== false ? cur : undefined));
}
async function giveCoins(to: string, amount: number, why: string) {
  if (amount <= 0) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${to}/${id}`, { id, from: "turnir", fromName: why, item: "coins:" + Math.round(amount), at: Date.now() });
}
export const money = (t: Tour) => !!(t.eur || t.stake);
const holding = (p: Paid) => !p.refunded && !p.refund; // the entry still counts (no refund done or owed)
const owed = (p: Paid) => (!!p.refund && !p.refunded) || (!!p.backDue && !p.back);
const stakes = (t: Tour) => Object.fromEntries(Object.entries(t.paid || {}).filter(([, p]) => holding(p)).map(([s, p]) => [s, p.eur]));
const pot = (t: Tour) => money(t) ? Math.round(Object.values(stakes(t)).reduce((a, v) => a + v, 0) * 100) / 100 : t.fee * t.players.length + t.bonus; // euros, or coins
const minPlayers = (t: Tour) => t.min || MIN_MONEY;
const hasOwed = (t: Tour) => Object.values(t.paid || {}).some(owed);
// the pot shared by stake: ranking = everybody, best first. Returns what each one wins and what goes back unmatched.
export function splitPot(st: Record<string, number>, ranking: string[], shares = SPLIT_EUR) {
  const win: Record<string, number> = {}, back: Record<string, number> = {};
  let prev = 0;
  for (const L of [...new Set(Object.values(st))].sort((a, b) => a - b)) {
    const inn = Object.keys(st).filter((s) => st[s] >= L), layer = (L - prev) * inn.length; prev = L;
    if (inn.length === 1) { back[inn[0]] = (back[inn[0]] || 0) + layer; continue; } // nobody matched this part
    const best = ranking.filter((s) => inn.includes(s)).slice(0, shares.length), sum = shares.slice(0, best.length).reduce((a, b) => a + b, 0);
    best.forEach((s, i) => { win[s] = (win[s] || 0) + layer * shares[i] / sum; });
  }
  for (const o of [win, back]) for (const k in o) o[k] = Math.floor(o[k] * 100 + 1e-6) / 100;
  return { win, back };
}

// every entry that is still held is owed back (the tournament is called off)
function markCancelling(t: Tour, why: string) {
  t.status = "cancelling";
  for (const pd of Object.values(t.paid || {})) if (holding(pd)) pd.refund = { why, tries: 0 };
}
// a money tournament that never reached its minimum: called off an hour after its start time, every entry refunded
const dueCancel = (t: Tour) => money(t) && t.status === "open" && t.players.length < minPlayers(t) && Date.now() >= t.start + 3600000;
const autoCancel = (id: string) => updateTour(id, (t) => { if (!dueCancel(t)) return false; markCancelling(t, `Vijuga: turnir nije skupio ${minPlayers(t)} igrača`); });

// Pay what is owed back to the cards: full refunds and unmatched parts. Stripe is asked first; the outcome is written
// after (compare-and-swap). The same refund asked twice is made once (idempotency key), so two of these at once are safe.
export async function settle(id: string, opts: { force?: boolean; only?: string[]; max?: number; timeout?: number } = {}) {
  const t0 = (await tours().get(id, { type: "json" })) as Tour | null; if (!t0) return { t: null as Tour | null, failed: [] as string[] };
  const now = Date.now(), due = (p?: Pending) => opts.force || !p || !p.last || now - p.last >= retryGap(p.tries);
  const jobs: { s: string; kind: "full" | "back"; pi: string; cents?: number; why: string }[] = [];
  for (const [s, p] of Object.entries(t0.paid || {})) {
    if (opts.only && !opts.only.includes(s)) continue;
    if (p.refund && !p.refunded) { if (due(p.refund)) jobs.push({ s, kind: "full", pi: p.pi, why: p.refund.why }); }
    else if (p.backDue && !p.back && due(p.backTry)) jobs.push({ s, kind: "back", pi: p.pi, cents: Math.round(p.backDue * 100), why: "Vijuga: dio uloga koji nitko nije pratio" });
  }
  const done = await Promise.all(jobs.slice(0, opts.max ?? 50).map(async (j) => {
    try { await refund(j.pi, j.why, j.cents, opts.timeout); return { ...j, ok: true, err: "" }; }
    catch (e) { const err = String((e as Error)?.message || e).slice(0, 160); return { ...j, ok: /already been refunded/i.test(err), err }; } // refunded before (e.g. the idempotency key expired)
  }));
  if (!done.length && !(t0.status === "cancelling" && !hasOwed(t0))) return { t: t0, failed: [] };
  // (if this write cannot get through, the refunds stay owed and the next try gets the same answer from Stripe)
  const t = await updateTour(id, (t) => {
    for (const r of done) {
      const p = t.paid?.[r.s]; if (!p || p.pi !== r.pi) continue;
      if (r.kind === "full") { if (!p.refund || p.refunded) continue; if (r.ok) { p.refunded = now; delete p.refund; } else Object.assign(p.refund, { tries: p.refund.tries + 1, last: now, err: r.err }); }
      else { if (!p.backDue || p.back) continue; if (r.ok) { p.back = p.backDue; delete p.backDue; delete p.backTry; } else p.backTry = { why: r.why, tries: (p.backTry?.tries || 0) + 1, last: now, err: r.err }; }
    }
    if (t.status === "cancelling" && !Object.values(t.paid || {}).some((p) => p.refund && !p.refunded)) t.status = "cancelled";
  }).catch(() => null);
  if (!t) return { t: t0, failed: done.map((r) => r.s) };
  return { t, failed: done.filter((r) => !r.ok).map((r) => r.s) };
}
// GET answers stay fast: what is owed is paid after the answer (Netlify keeps the function alive for it). Where that hook
// does not exist (tests), it is done before answering, and the fresher tournament is returned.
async function settleLater(context: Context, id: string, t: Tour) {
  if (!hasOwed(t)) return t;
  const p = settle(id, { max: 3, timeout: 5000 }).catch(() => ({ t: null }));
  if (typeof context.waitUntil === "function") { context.waitUntil(p); return t; }
  return (await p).t || t;
}

// the public view never shows payment ids, and only admins see who reported what
function table(tb: Table | null, admin: boolean) {
  if (!tb) return tb;
  const { reports, ...rest } = tb;
  return admin ? { ...rest, reports: reports || {} } : { ...rest, reported: Object.keys(reports || {}) };
}
const view = (t: Tour, admin = false) => {
  const { paid, rounds, final, ...rest } = t; const P = paid || {};
  return {
    ...rest, rounds: rounds.map((r) => ({ ...r, tables: r.tables.map((x) => table(x, admin)) })), final: table(final, admin),
    paidSlugs: Object.keys(P).filter((s) => holding(P[s])), stakes: stakes(t),
    back: Object.fromEntries(Object.entries(P).filter(([, p]) => p.back).map(([s, p]) => [s, p.back])),
    refunding: Object.keys(P).filter((s) => owed(P[s])), // money on its way back to these players' cards
    ...(admin ? { refunds: Object.fromEntries(Object.entries(P).filter(([, p]) => owed(p)).map(([s, p]) => { const q = p.refund && !p.refunded ? p.refund : p.backTry; return [s, { eur: p.refund && !p.refunded ? p.eur : p.backDue, tries: q?.tries || 0, err: q?.err || null }]; })) } : {}),
  };
};
const nameOf = (t: Tour, s: string) => t.players.find((p) => p.slug === s)?.name || s;

// tables of up to 5, balanced by current points (snake order so strong players spread out)
function makeTables(t: Tour, k: number): Table[] {
  const order = [...t.players.map((p) => p.slug)].sort((a, b) => (t.points[b] || 0) - (t.points[a] || 0) || (k === 1 ? Math.random() - 0.5 : a.localeCompare(b)));
  const n = Math.max(1, Math.ceil(order.length / TABLE));
  const tables: Table[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, players: [], result: null }));
  order.forEach((s, i) => { const row = Math.floor(i / n), col = row % 2 ? n - 1 - (i % n) : i % n; tables[col].players.push(s); });
  return tables;
}
function advance(t: Tour) {
  if (t.status === "running") {
    const cur = t.rounds[t.rounds.length - 1];
    if (!cur || cur.tables.some((x) => !x.result)) return;
    if (t.rounds.length < ROUNDS) { t.rounds.push({ k: t.rounds.length + 1, at: Date.now(), tables: makeTables(t, t.rounds.length + 1) }); return; }
    const top = [...t.players.map((p) => p.slug)].sort((a, b) => (t.points[b] || 0) - (t.points[a] || 0)).slice(0, TABLE);
    t.final = { id: 0, players: top, result: null, at: Date.now() }; t.status = "final"; return;
  }
}
const findTable = (t: Tour, k: number, tid: number) => t.status === "running" ? t.rounds.find((r) => r.k === k)?.tables.find((x) => x.id === tid) || null : t.status === "final" && k === 0 ? t.final : null;
const startedAt = (t: Tour, k: number) => (k === 0 ? t.final?.at : t.rounds.find((r) => r.k === k)?.at) || 0;
// a table's order becomes its result; the final also shares the pot. Returns the coin prizes to hand out after the write.
function close(t: Tour, tb: Table, order: string[], by: string) {
  tb.result = order; tb.by = by;
  if (t.status === "running") { order.forEach((s, i) => { t.points[s] = (t.points[s] || 0) + (POINTS[i] ?? 0); }); advance(t); return []; }
  const total = pot(t); let prizes: { slug: string; prize: number; place: number }[] = [];
  if (money(t)) { // euros, shared by stake: the organiser pays the winnings and marks each one; an unmatched part goes back to the card
    const ranking = [...order, ...t.players.map((p) => p.slug).filter((s) => !order.includes(s)).sort((a, b) => (t.points[b] || 0) - (t.points[a] || 0))];
    const { win, back } = splitPot(stakes(t), ranking);
    t.winners = ranking.slice(0, 3).map((s) => ({ slug: s, name: nameOf(t, s), prize: win[s] || 0 }));
    t.payouts = ranking.map((s, i) => ({ slug: s, name: nameOf(t, s), place: i + 1, eur: win[s] || 0, paid: false })).filter((p) => p.eur > 0);
    for (const [s, eur] of Object.entries(back)) { const pd = t.paid?.[s]; if (pd && !pd.back && !pd.backDue && eur > 0) pd.backDue = eur; }
  } else {
    t.winners = order.slice(0, 3).map((s, i) => ({ slug: s, name: nameOf(t, s), prize: Math.floor(total * SPLIT[i]) }));
    prizes = t.winners.map((w, i) => ({ slug: w.slug, prize: w.prize, place: i + 1 }));
  }
  t.status = "done";
  return prizes;
}

type Outcome = { fail?: [string, number, Record<string, unknown>?]; flag?: boolean; prizes?: { slug: string; prize: number; place: number }[] };

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = tours(); const id = context.params.id, action = context.params.action;
  if (req.method === "GET") {
    if (id) {
      let t = (await store.get(id, { type: "json" })) as Tour | null; if (!t) return json({ error: "not found" }, 404);
      if (dueCancel(t)) t = (await autoCancel(id)) || t;
      t = await settleLater(context, id, t);
      return json({ tournament: view(t), pot: pot(t) });
    }
    const { blobs } = await store.list();
    let all = ((await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))) as Tour[]).filter(Boolean).sort((a, b) => b.start - a.start).slice(0, 10);
    all = await Promise.all(all.map(async (t) => (dueCancel(t) ? (await autoCancel(t.id)) || t : t)));
    let n = 0; all = await Promise.all(all.map((t) => (hasOwed(t) && n++ < 2 ? settleLater(context, t.id, t) : t)));
    return json({ tournaments: all.map((t) => ({ ...view(t), pot: pot(t) })), payments: stripeOn(), test: stripeTest() });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""); const { acc, gate } = await authed(req, context, slug, b.auth);
  if (!gate.ok || !acc) return gate.ok === false && gate.status === 429 ? json({ error: gate.error, wait: gate.wait }, 429) : json({ error: "auth" }, 403);
  // master and admins run tournaments and add to the pot; tournament leaders run them but cannot add coins.
  // Every admin action needs an account with a PIN: without one anybody could act as it.
  const role = await roleOf(slug), hasPin = !!acc.pinHash;
  const admin = ["master", "admin", "turnir"].includes(role), canBonus = role === "master" || role === "admin";
  const adminOnly = (ok: boolean) => !ok ? json({ error: "admin only" }, 403) : !hasPin ? json({ error: "pin needed" }, 403) : null;
  const seesReports = admin && hasPin;
  const answer = (t: Tour, extra: Record<string, unknown> = {}, status = 200) => json({ tournament: view(t, seesReports), pot: pot(t), ...extra }, status);
  const failed = (o: Outcome) => (o.fail ? json({ error: o.fail[0], ...(o.fail[2] || {}) }, o.fail[1]) : null);

  if (!id) { // create
    const no = adminOnly(admin); if (no) return no;
    const start = Number(b.start); if (!Number.isFinite(start) || start < Date.now() - 3600000) return json({ error: "bad start" }, 400);
    // a starting pot is paid from the master's treasury
    // real money: a fixed stake (eur) or a stake chosen by each player between stakeMin and stakeMax, whole euros up to 100
    const whole = (v: unknown) => { const x = Math.floor(Number(v)); return x >= 1 && x <= EUR_MAX ? x : 0; };
    const eur = whole(b.eur), smin = whole(b.stakeMin), smax = whole(b.stakeMax), free = !eur && smin > 0 && smax >= smin;
    if (b.eur != null && Number(b.eur) && !eur) return json({ error: "bad stake" }, 400);
    if ((eur || free) && !canBonus) return json({ error: "admin only" }, 403); // real money: master and admins only
    if ((eur || free) && !stripeOn()) return json({ error: "payments off" }, 503);
    const bonus = canBonus && !eur && !free ? Math.max(0, Math.min(100000, Math.floor(Number(b.bonus) || 0))) : 0;
    if (bonus) { const tr = await treasury(-bonus); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409); }
    const t: Tour = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4), name: String(b.name || "Turnir").slice(0, 40), start, max: Math.max(2, Math.min(40, Math.floor(Number(b.max) || 16))), fee: eur || free ? 0 : FEE, bonus, created: Date.now(), status: "open", players: [], rounds: [], points: {}, final: null, winners: [] };
    if (eur || free) { if (eur) t.eur = eur; else t.stake = { min: smin, max: smax }; t.paid = {}; t.test = stripeTest(); t.min = t.test ? MIN_DEMO : MIN_MONEY; t.max = Math.max(t.min, t.max); }
    const w = await store.setJSON(t.id, t, { onlyIfNew: true });
    if (!w.modified) { if (bonus) await treasury(bonus); return json({ error: "busy" }, 503); }
    return answer(t);
  }
  const t0 = (await store.get(id, { type: "json" })) as Tour | null; if (!t0) return json({ error: "not found" }, 404);
  const o: Outcome = {};
  const run = async (fn: (t: Tour) => boolean | void) => { const t = await updateTour(id, (t) => { o.fail = undefined; o.flag = false; o.prizes = undefined; return fn(t); }); return t || t0; };

  if (action === "view") return answer(await settleLater(context, id, t0));
  if (action === "join") {
    // a coin tournament: the fee is taken from the account here (the game shows the same) before the player is written
    // in, and given back if that does not happen. The write itself checks that the fee was taken, so a join racing a
    // leave of the same player cannot get in for free.
    const fee = !money(t0) ? Number(t0.fee) || 0 : 0; let charged = 0, rev: unknown = null, prev: unknown = null;
    if (fee && !b.w) return json({ error: "update" }, 409); // a page from before the server wallet would pay twice
    if (fee && !(await owns(acc, b.claim))) return json({ error: "pin needed" }, 403);
    const charge = async () => { const a2 = await bump(slug, (d) => { if ((Number(d.coins) || 0) < fee) return false; d.coins -= fee; d.spent = (Number(d.spent) || 0) + fee; }); if (!a2) return false; charged = fee; rev = rev == null ? a2.updatedAt : null; prev = prev == null ? a2._prev : prev; return true; };
    const refund = () => bump(slug, (d) => { d.coins += charged; d.spent = Math.max(0, (Number(d.spent) || 0) - charged); });
    if (fee && t0.status === "open" && !t0.players.some((p) => p.slug === slug)) { if (!(await charge())) return json({ error: "not enough coins" }, 409); }
    let t: Tour | null = null;
    try {
      for (let i = 0; i < 3; i++) {
        let unpaid = false;
        t = await run((t) => {
          unpaid = false;
          if (money(t)) { o.fail = ["payment required", 402]; return false; } // a money tournament is entered by paying (pay.mts)
          if (t.status !== "open") { o.fail = ["registration closed", 409]; return false; }
          if (t.players.some((p) => p.slug === slug)) { o.flag = true; return false; }
          if (t.players.length >= t.max) { o.fail = ["full", 409]; return false; }
          if (fee && !charged) { unpaid = true; return false; }
          t.players.push({ slug, name: String(acc.name ?? slug).slice(0, 14) });
        });
        if (!unpaid) break;
        if (!(await charge())) return json({ error: "not enough coins" }, 409);
      }
    } catch (e) { if (charged) await refund(); throw e; }
    if (charged && (failed(o) || o.flag)) { await refund(); return failed(o) || answer(t!, { already: true }); }
    return failed(o) || answer(t!, o.flag ? { already: true } : charged ? { charged, rev, prev } : {});
  }
  if (action === "leave") {
    const t = await run((t) => {
      if (t.status !== "open") { o.fail = ["already started", 409]; return false; }
      if (!t.players.some((p) => p.slug === slug)) return false;
      t.players = t.players.filter((p) => p.slug !== slug); o.flag = true;
      const pd = t.paid?.[slug]; if (money(t) && pd && holding(pd)) pd.refund = { why: "Vijuga: odjava s turnira", tries: 0 };
    });
    const no = failed(o); if (no) return no;
    if (o.flag && !money(t)) await giveCoins(slug, t.fee, "Turnir: povrat kotizacije");
    if (o.flag && money(t)) { const s = await settle(id, { only: [slug], force: true }); return answer(s.t || t, s.failed.length ? { refund: "pending" } : {}); } // a failed refund stays owed and is tried again
    return answer(t);
  }
  if (action === "bonus") {
    const no = adminOnly(canBonus); if (no) return no;
    if (money(t0)) return json({ error: "money tournament" }, 409);
    const add = Math.max(0, Math.min(100000, Math.floor(Number(b.amount) || 0))); if (!add) return answer(t0);
    const tr = await treasury(-add); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409);
    const t = await run((t) => { if (money(t) || t.status === "done" || t.status === "cancelled") return false; t.bonus += add; o.flag = true; });
    if (!o.flag) { await treasury(add); return json({ error: "closed" }, 409); } // too late: the coins go back to the treasury
    return answer(t);
  }
  if (action === "cancel") {
    const no = adminOnly(admin); if (no) return no;
    const t = await run((t) => {
      if (t.status === "done" || t.status === "cancelled") return false;
      if (money(t)) { if (t.status === "cancelling") return false; markCancelling(t, "Vijuga: turnir otkazan"); return; }
      t.status = "cancelled"; o.flag = true;
    });
    if (o.flag) { for (const p of t.players) await giveCoins(p.slug, t.fee, "Turnir otkazan: povrat kotizacije"); if (t.bonus) await treasury(t.bonus); }
    if (money(t) && t.status === "cancelling") { // every entry back to its card; whatever fails stays owed and an admin's next cancel tries again
      const s = await settle(id, { force: true }), cur = s.t || t;
      if (s.failed.length) return answer(cur, { error: "refund failed", failed: s.failed.length }, 502);
      return answer(cur);
    }
    return answer(t);
  }
  if (action === "start") {
    const no = adminOnly(admin); if (no) return no;
    const t = await run((t) => {
      if (t.status !== "open") { o.fail = ["not open", 409]; return false; }
      if (t.players.length < 2) { o.fail = ["need 2 players", 409]; return false; }
      if (money(t) && t.players.length < minPlayers(t)) { o.fail = ["need players", 409, { min: minPlayers(t) }]; return false; }
      t.status = "running"; t.rounds = [{ k: 1, at: Date.now(), tables: makeTables(t, 1) }];
    });
    return failed(o) || answer(t);
  }
  if (action === "result" || action === "confirm") {
    const k = Number(b.round), tid = Number(b.table);
    const ranking = [...new Set((Array.isArray(b.ranking) ? b.ranking : []).map(String).filter((s) => SLUG.test(s)))];
    if (action === "confirm") { const no = adminOnly(admin); if (no) return no; }
    const t = await run((t) => {
      const tb = findTable(t, k, tid); if (!tb) { o.fail = ["no such table", 404]; return false; }
      if (tb.result) return false; // the result is settled
      const seated = tb.players.includes(slug), now = Date.now(), since = now - startedAt(t, k);
      if (action === "confirm") { // an admin picks one of the reports
        if (money(t) && !canBonus) { o.fail = ["admin only", 403]; return false; }
        if (money(t) && seated) { o.fail = ["own table", 403]; return false; } // nobody decides a money table they play at
        const rep = tb.reports?.[String(b.reportOf ?? "")]; if (!rep) { o.fail = ["no such report", 404]; return false; }
        o.prizes = close(t, tb, rep, "confirm:" + slug); return;
      }
      if (seated) { // a player's report
        if (since < REPORT_AFTER) { o.fail = ["too early", 409, { wait: Math.ceil((REPORT_AFTER - since) / 1000) }]; return false; }
        // players who did not show up are ranked last, in their seat order
        const order = [...ranking.filter((s) => tb.players.includes(s)), ...tb.players.filter((s) => !ranking.includes(s))];
        tb.reports = tb.reports || {}; tb.reports[slug] = order;
        // real money: a strict majority of the table must send the same order (or an admin confirms one); coins: the first report
        if (money(t) && Object.values(tb.reports).filter((x) => x.join() === order.join()).length * 2 <= tb.players.length) return;
        o.prizes = close(t, tb, order, "players"); return;
      }
      // an admin who is not at the table closes it without a match: seat order
      if (!admin) { o.fail = ["not at this table", 403]; return false; }
      if (!hasPin) { o.fail = ["pin needed", 403]; return false; }
      if (money(t)) {
        if (!canBonus) { o.fail = ["admin only", 403]; return false; }
        if (Object.keys(tb.reports || {}).length) { o.fail = ["confirm a report", 409]; return false; }
        if (since < FORFEIT_AFTER) { o.fail = ["too early", 409, { wait: Math.ceil((FORFEIT_AFTER - since) / 1000) }]; return false; }
      }
      o.prizes = close(t, tb, [...tb.players], "forfeit:" + slug);
    });
    const no = failed(o); if (no) return no;
    for (const w of o.prizes || []) await giveCoins(w.slug, w.prize, `Turnir „${t.name}”: ${w.place}. mjesto`);
    return answer(await settleLater(context, id, t)); // a part of a stake nobody matched goes back to the card
  }
  if (action === "paidout") { // master / admin: the prize of this winner has been paid out
    const no = adminOnly(canBonus); if (no) return no;
    const t = await run((t) => {
      const po = (t.payouts || []).find((x) => x.slug === String(b.winner ?? "")); if (!po) { o.fail = ["no such winner", 404]; return false; }
      po.paid = b.paid !== false; po.at = po.paid ? Date.now() : undefined;
    });
    return failed(o) || answer(t);
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/tournament", "/api/tournament/:id", "/api/tournament/:id/:action"] };
