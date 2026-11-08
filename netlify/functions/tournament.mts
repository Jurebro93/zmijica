// Coin tournaments for Vijuga.
// Players pay the entry fee from their own coins (in the game); prizes and refunds arrive as gifts ("coins:N").
// Format: 3 qualifying rounds at tables of up to 5 (points 10/6/3/1/0), then a final of the top 5. Pot: 60/30/10 %.
// GET  /api/tournament              -> recent tournaments
// GET  /api/tournament/:id          -> one tournament
// POST /api/tournament              {slug, auth, name, start, max, bonus}   (admin) create
// POST /api/tournament/:id/:action  {slug, auth, ...}  join | leave | start (admin) | bonus (admin) | cancel (admin) | result
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { roleOf, treasury } from "./roles.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const FEE = 500, ROUNDS = 3, TABLE = 5, POINTS = [10, 6, 3, 1, 0], SPLIT = [0.6, 0.3, 0.1];

type Table = { id: number; players: string[]; result: string[] | null };
type Tour = {
  id: string; name: string; start: number; max: number; fee: number; bonus: number; created: number;
  status: "open" | "running" | "final" | "done" | "cancelled";
  players: { slug: string; name: string }[]; rounds: { k: number; tables: Table[] }[];
  points: Record<string, number>; final: Table | null; winners: { slug: string; name: string; prize: number }[];
};

const tours = () => getStore({ name: "vijuga-tournaments", consistency: "strong" });
async function account(slug: string) { return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null; }
async function authed(slug: string, auth: unknown) { if (!SLUG.test(slug)) return null; const a = await account(slug); if (!a) return null; if (a.pinHash && a.pinHash !== auth) return null; return a; }
async function giveCoins(to: string, amount: number, why: string) {
  if (amount <= 0) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await getStore({ name: "vijuga-gifts", consistency: "strong" }).setJSON(`${to}/${id}`, { id, from: "turnir", fromName: why, item: "coins:" + Math.round(amount), at: Date.now() });
}
const pot = (t: Tour) => t.fee * t.players.length + t.bonus;
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
    if (id) { const t = await store.get(id, { type: "json" }); return t ? json({ tournament: t, pot: pot(t as Tour) }) : json({ error: "not found" }, 404); }
    const { blobs } = await store.list();
    const all = ((await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))) as Tour[]).filter(Boolean).sort((a, b) => b.start - a.start).slice(0, 10);
    return json({ tournaments: all.map((t) => ({ ...t, pot: pot(t) })) });
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
    let bonus = canBonus ? Math.max(0, Math.min(100000, Math.floor(Number(b.bonus) || 0))) : 0;
    if (bonus) { const tr = await treasury(-bonus); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409); }
    const t: Tour = { id: Date.now().toString(36), name: String(b.name || "Turnir").slice(0, 40), start, max: Math.max(2, Math.min(40, Math.floor(Number(b.max) || 16))), fee: FEE, bonus, created: Date.now(), status: "open", players: [], rounds: [], points: {}, final: null, winners: [] };
    await store.setJSON(t.id, t); return json({ tournament: t, pot: pot(t) });
  }
  const t = (await store.get(id, { type: "json" })) as Tour | null; if (!t) return json({ error: "not found" }, 404);
  const save = async () => { await store.setJSON(t.id, t); return json({ tournament: t, pot: pot(t) }); };

  if (action === "join") {
    if (t.status !== "open") return json({ error: "registration closed" }, 409);
    if (t.players.some((p) => p.slug === slug)) { const r = await save(); const j = await r.json(); return json({ ...j, already: true }); }
    if (t.players.length >= t.max) return json({ error: "full" }, 409);
    t.players.push({ slug, name: String(acc.name ?? slug).slice(0, 14) }); return save();
  }
  if (action === "leave") {
    if (t.status !== "open") return json({ error: "already started" }, 409);
    if (!t.players.some((p) => p.slug === slug)) return save();
    t.players = t.players.filter((p) => p.slug !== slug); await giveCoins(slug, t.fee, "Turnir: povrat kotizacije"); return save();
  }
  if (action === "bonus") {
    if (!canBonus) return json({ error: "admin only" }, 403);
    const add = Math.max(0, Math.min(100000, Math.floor(Number(b.amount) || 0))); if (!add) return save();
    const tr = await treasury(-add); if (!tr.ok) return json({ error: "treasury", treasury: tr.value }, 409);
    t.bonus += add; return save();
  }
  if (action === "cancel") {
    if (!admin) return json({ error: "admin only" }, 403); if (t.status === "done" || t.status === "cancelled") return save();
    for (const p of t.players) await giveCoins(p.slug, t.fee, "Turnir otkazan: povrat kotizacije");
    if (t.bonus) await treasury(t.bonus);
    t.status = "cancelled"; return save();
  }
  if (action === "start") {
    if (!admin) return json({ error: "admin only" }, 403); if (t.status !== "open") return json({ error: "not open" }, 409);
    if (t.players.length < 2) return json({ error: "need 2 players" }, 409);
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
    if (table.result) return save(); // first report counts
    // players who did not show up are ranked last, in their seat order
    const order = [...ranking.filter((s) => table!.players.includes(s)), ...table.players.filter((s) => !ranking.includes(s))];
    table.result = order;
    if (t.status === "running") { order.forEach((s, i) => { t.points[s] = (t.points[s] || 0) + (POINTS[i] ?? 0); }); advance(t); }
    else {
      const total = pot(t); t.winners = order.slice(0, 3).map((s, i) => ({ slug: s, name: nameOf(t, s), prize: Math.floor(total * SPLIT[i]) }));
      for (const w of t.winners) await giveCoins(w.slug, w.prize, `Turnir „${t.name}”: ${t.winners.indexOf(w) + 1}. mjesto`);
      t.status = "done";
    }
    return save();
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/tournament", "/api/tournament/:id", "/api/tournament/:id/:action"] };
