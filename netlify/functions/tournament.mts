// Coin tournaments for Vijuga.
// Players pay the entry fee from their own coins (in the game); prizes and refunds arrive as gifts ("coins:N").
// Format: 3 qualifying rounds at tables of up to 5 (points 10/6/3/1/0), then a final of the top 5. Pot: 60/30/10 %.
// GET  /api/tournament              -> recent tournaments
// GET  /api/tournament/:id          -> one tournament
// POST /api/tournament              {slug, auth, name, start, max, bonus}   (admin) create
// POST /api/tournament/:id/:action  {slug, auth, ...}  join | leave | start (admin) | bonus (admin) | cancel (admin) | result | paidout (admin)
// Real-money tournaments: a fixed stake (eur) or a stake each player chooses between stake.min and stake.max, paid
// through Stripe (pay.mts); at least 6 players (2 with a sandbox key: demo money); leaving or a cancelled tournament
// refunds the payment; a table result counts once an admin or two players at the table report the same order.
// The pot is shared by stake ("side pots"): from each player you can win at most what you staked yourself. Every stake
// level is a pot shared 50/30/20 by the best three of those who staked that much; a part nobody matched goes back.
// Winnings are paid out by the organiser and marked here; unmatched parts are refunded to the card at once.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { roleOf, treasury } from "./roles.mts";
import { refund, stripeOn, stripeTest } from "./stripe.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const FEE = 500, ROUNDS = 3, TABLE = 5, POINTS = [10, 6, 3, 1, 0], SPLIT = [0.6, 0.3, 0.1];
const MIN_MONEY = 6, MIN_DEMO = 2, SPLIT_EUR = [0.5, 0.3, 0.2], EUR_MAX = 100;

type Table = { id: number; players: string[]; result: string[] | null; reports?: Record<string, string[]> };
type Paid = { eur: number; pi: string; session: string; at: number; refunded?: number; back?: number };
type Tour = {
  id: string; name: string; start: number; max: number; fee: number; bonus: number; created: number;
  status: "open" | "running" | "final" | "done" | "cancelled";
  players: { slug: string; name: string }[]; rounds: { k: number; tables: Table[] }[];
  points: Record<string, number>; final: Table | null; winners: { slug: string; name: string; prize: number }[];
  eur?: number; stake?: { min: number; max: number }; min?: number; test?: boolean; paid?: Record<string, Paid>;
  payouts?: { slug: string; name: string; place: number; eur: number; paid: boolean; at?: number }[];
};

const tours = () => getStore({ name: "vijuga-tournaments", consistency: "strong" });
async function account(slug: string) { return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null; }
async function authed(slug: string, auth: unknown) { if (!SLUG.test(slug)) return null; const a = await account(slug); if (!a) return null; if (a.pinHash && a.pinHash !== auth) return null; return a; }
async function giveCoins(to: string, amount: number, why: string) {
  if (amount <= 0) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${to}/${id}`, { id, from: "turnir", fromName: why, item: "coins:" + Math.round(amount), at: Date.now() });
}
export const money = (t: Tour) => !!(t.eur || t.stake);
const stakes = (t: Tour) => Object.fromEntries(Object.entries(t.paid || {}).filter(([, p]) => !p.refunded).map(([s, p]) => [s, p.eur]));
const pot = (t: Tour) => money(t) ? Math.round(Object.values(stakes(t)).reduce((a, v) => a + v, 0) * 100) / 100 : t.fee * t.players.length + t.bonus; // euros, or coins
const minPlayers = (t: Tour) => t.min || MIN_MONEY;
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
// a paid entry goes back to the card it came from
async function refundEntry(t: Tour, slug: string, why: string) {
  const pd = t.paid && t.paid[slug]; if (!pd || pd.refunded) return true;
  try { await refund(pd.pi, why); pd.refunded = Date.now(); return true; } catch (e) { return false; }
}
// a money tournament that never reached 6 players: cancelled an hour after its start time, every entry refunded
async function autoCancel(t: Tour) {
  if (!money(t) || t.status !== "open" || t.players.length >= minPlayers(t) || Date.now() < t.start + 3600000) return false;
  for (const p of t.players) await refundEntry(t, p.slug, `Vijuga: turnir nije skupio ${minPlayers(t)} igrača`);
  t.status = "cancelled"; return true;
}
// the public view never shows payment ids
const view = (t: Tour) => { const { paid, ...rest } = t; return { ...rest, paidSlugs: Object.keys(paid || {}).filter((s) => !paid![s].refunded), stakes: stakes(t), back: Object.fromEntries(Object.entries(paid || {}).filter(([, p]) => p.back).map(([s, p]) => [s, p.back])) }; };
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
    if (t.rounds.length < ROUNDS) { t.rounds.push({ k: t.rounds.length + 1, tables: makeTables(t, t.rounds.length + 1) }); return; }
    const top = [...t.players.map((p) => p.slug)].sort((a, b) => (t.points[b] || 0) - (t.points[a] || 0)).slice(0, TABLE);
    t.final = { id: 0, players: top, result: null }; t.status = "final"; return;
  }
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = tours(); const id = context.params.id, action = context.params.action;
  if (req.method === "GET") {
    if (id) { const t = await store.get(id, { type: "json" }) as Tour | null; if (!t) return json({ error: "not found" }, 404); if (await autoCancel(t)) await store.setJSON(t.id, t); return json({ tournament: view(t), pot: pot(t) }); }
    const { blobs } = await store.list();
    const all = ((await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))) as Tour[]).filter(Boolean).sort((a, b) => b.start - a.start).slice(0, 10);
    for (const t of all) if (await autoCancel(t)) await store.setJSON(t.id, t);
    return json({ tournaments: all.map((t) => ({ ...view(t), pot: pot(t) })), payments: stripeOn(), test: stripeTest() });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""); const acc = await authed(slug, b.auth); if (!acc) return json({ error: "auth" }, 403);
  // master and admins run tournaments and add to the pot; tournament leaders run them but cannot add coins
  const role = await roleOf(slug); const admin = ["master", "admin", "turnir"].includes(role); const canBonus = role === "master" || role === "admin";

  if (!id) { // create
    if (!admin) return json({ error: "admin only" }, 403);
    const start = Number(b.start); if (!Number.isFinite(start) || start < Date.now() - 3600000) return json({ error: "bad start" }, 400);
    // a starting pot is paid from the master's treasury
    // real money: a fixed stake (eur) or a stake chosen by each player between stakeMin and stakeMax, whole euros up to 100
    const whole = (v: unknown) => { const x = Math.floor(Number(v)); return x >= 1 && x <= EUR_MAX ? x : 0; };
    const eur = whole(b.eur), smin = whole(b.stakeMin), smax = whole(b.stakeMax), free = !eur && smin > 0 && smax >= smin;
    if (b.eur != null && Number(b.eur) && !eur) return json({ error: "bad stake" }, 400);
    if ((eur || free) && !canBonus) return json({ error: "admin only" }, 403); // real money: master and admins only
    if ((eur || free) && !stripeOn()) return json({ error: "payments off" }, 503);
    let bonus = canBonus && !eur && !free ? Math.max(0, Math.min(100000, Math.floor(Number(b.bonus) || 0))) : 0;
    if (bonus) { const tr = await treasury(-bonus); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409); }
    const t: Tour = { id: Date.now().toString(36), name: String(b.name || "Turnir").slice(0, 40), start, max: Math.max(2, Math.min(40, Math.floor(Number(b.max) || 16))), fee: eur || free ? 0 : FEE, bonus, created: Date.now(), status: "open", players: [], rounds: [], points: {}, final: null, winners: [] };
    if (eur || free) { if (eur) t.eur = eur; else t.stake = { min: smin, max: smax }; t.paid = {}; t.test = stripeTest(); t.min = t.test ? MIN_DEMO : MIN_MONEY; t.max = Math.max(t.min, t.max); }
    await store.setJSON(t.id, t); return json({ tournament: view(t), pot: pot(t) });
  }
  const t = (await store.get(id, { type: "json" })) as Tour | null; if (!t) return json({ error: "not found" }, 404);
  const save = async () => { await store.setJSON(t.id, t); return json({ tournament: view(t), pot: pot(t) }); };

  if (action === "join") {
    if (money(t)) return json({ error: "payment required" }, 402); // a money tournament is entered by paying (pay.mts)
    if (t.status !== "open") return json({ error: "registration closed" }, 409);
    if (t.players.some((p) => p.slug === slug)) { const r = await save(); const j = await r.json(); return json({ ...j, already: true }); }
    if (t.players.length >= t.max) return json({ error: "full" }, 409);
    t.players.push({ slug, name: String(acc.name ?? slug).slice(0, 14) }); return save();
  }
  if (action === "leave") {
    if (t.status !== "open") return json({ error: "already started" }, 409);
    if (!t.players.some((p) => p.slug === slug)) return save();
    if (money(t)) { if (!(await refundEntry(t, slug, "Vijuga: odjava s turnira"))) return json({ error: "refund failed" }, 502); }
    t.players = t.players.filter((p) => p.slug !== slug); if (!money(t)) await giveCoins(slug, t.fee, "Turnir: povrat kotizacije"); return save();
  }
  if (action === "bonus") {
    if (!canBonus) return json({ error: "admin only" }, 403);
    if (money(t)) return json({ error: "money tournament" }, 409);
    const add = Math.max(0, Math.min(100000, Math.floor(Number(b.amount) || 0))); if (!add) return save();
    const tr = await treasury(-add); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409);
    t.bonus += add; return save();
  }
  if (action === "cancel") {
    if (!admin) return json({ error: "admin only" }, 403); if (t.status === "done" || t.status === "cancelled") return save();
    if (money(t)) { let failed = 0; for (const p of t.players) if (!(await refundEntry(t, p.slug, "Vijuga: turnir otkazan"))) failed++; if (failed) { await store.setJSON(t.id, t); return json({ error: "refund failed", failed }, 502); } }
    else for (const p of t.players) await giveCoins(p.slug, t.fee, "Turnir otkazan: povrat kotizacije");
    if (t.bonus) await treasury(t.bonus);
    t.status = "cancelled"; return save();
  }
  if (action === "start") {
    if (!admin) return json({ error: "admin only" }, 403); if (t.status !== "open") return json({ error: "not open" }, 409);
    if (t.players.length < 2) return json({ error: "need 2 players" }, 409);
    if (money(t) && t.players.length < minPlayers(t)) return json({ error: "need players", min: minPlayers(t) }, 409);
    t.status = "running"; t.rounds = [{ k: 1, tables: makeTables(t, 1) }]; return save();
  }
  if (action === "result") {
    const ranking = (Array.isArray(b.ranking) ? b.ranking : []).map(String).filter((s) => SLUG.test(s));
    const k = Number(b.round), tid = Number(b.table);
    let table: Table | null = null;
    if (t.status === "running") table = t.rounds.find((r) => r.k === k)?.tables.find((x) => x.id === tid) || null;
    else if (t.status === "final" && k === 0) table = t.final;
    if (!table) return json({ error: "no such table" }, 404);
    if (!table.players.includes(slug) && !admin) return json({ error: "not at this table" }, 403);
    if (table.result) return save(); // the result is settled
    // players who did not show up are ranked last, in their seat order
    const order = [...ranking.filter((s) => table!.players.includes(s)), ...table.players.filter((s) => !ranking.includes(s))];
    if (money(t) && !admin) { // real money: one report is not enough, two players at the table must report the same order
      table.reports = table.reports || {}; table.reports[slug] = order;
      const same = Object.entries(table.reports).filter(([, o]) => o.join() === order.join()).length;
      if (same < 2) return save();
    }
    table.result = order;
    if (t.status === "running") { order.forEach((s, i) => { t.points[s] = (t.points[s] || 0) + (POINTS[i] ?? 0); }); advance(t); }
    else {
      const total = pot(t);
      if (money(t)) { // euros, shared by stake: the organiser pays the winnings and marks each one; an unmatched part goes back to the card
        const ranking = [...order, ...t.players.map((p) => p.slug).filter((s) => !order.includes(s)).sort((a, b) => (t.points[b] || 0) - (t.points[a] || 0))];
        const { win, back } = splitPot(stakes(t), ranking);
        t.winners = ranking.slice(0, 3).map((s) => ({ slug: s, name: nameOf(t, s), prize: win[s] || 0 }));
        t.payouts = ranking.map((s, i) => ({ slug: s, name: nameOf(t, s), place: i + 1, eur: win[s] || 0, paid: false })).filter((p) => p.eur > 0);
        for (const [s, eur] of Object.entries(back)) { const pd = t.paid![s]; if (!pd || pd.back) continue; try { await refund(pd.pi, "Vijuga: dio uloga koji nitko nije pratio", Math.round(eur * 100)); pd.back = eur; } catch (e) { /* the organiser can pay it back by hand */ } }
      } else {
        t.winners = order.slice(0, 3).map((s, i) => ({ slug: s, name: nameOf(t, s), prize: Math.floor(total * SPLIT[i]) }));
        for (const w of t.winners) await giveCoins(w.slug, w.prize, `Turnir „${t.name}”: ${t.winners.indexOf(w) + 1}. mjesto`);
      }
      t.status = "done";
    }
    return save();
  }
  if (action === "paidout") { // master / admin: the prize of this winner has been paid out
    if (!canBonus) return json({ error: "admin only" }, 403);
    const po = (t.payouts || []).find((x) => x.slug === String(b.winner ?? "")); if (!po) return json({ error: "no such winner" }, 404);
    po.paid = b.paid !== false; po.at = po.paid ? Date.now() : undefined; return save();
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/tournament", "/api/tournament/:id", "/api/tournament/:id/:action"] };
