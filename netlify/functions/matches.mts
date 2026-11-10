// Match log and stats for Vijuga.
// POST /api/matches  {mid, mode, rounds, players:[{name, slug, human, place, score, wins, kills}]} -> stores one finished match (once per mid)
// GET  /api/stats    -> totals, activity per day, per-player detail and recent matches
// POST /api/troll   {from, to, id} -> counts who pranked whom (fun stats only)
// DELETE /api/matches/:mid (header x-admin-key) -> remove one match (maintenance)
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
// SHA-256 of the maintenance key; the key itself is not stored in the repository.
const ADMIN_KEY_SHA256 = "f5200fc8e8b6f62b67cebbfb4087e15b344faffeb42fe51c14c4957ce940c306";

type MatchPlayer = { name: string; slug: string | null; human: boolean; place: number; score: number; wins: number; kills: number };
type Match = { mid: string; mode: "online" | "local"; rounds: number; at: number; players: MatchPlayer[]; kx?: [string, string, number][] };
type Account = { slug: string; name: string; color?: number; coins?: number; matches?: number; wins?: number; kills?: number; created?: number; updatedAt?: number; invitedBy?: string; eq?: { skin?: string; badge?: string }; owned?: string[]; inv?: Record<string, number>; spent?: number; purchases?: number; playMs?: number; siteMs?: number; trollsSent?: number; trollsGot?: number };

function cleanMatch(body: unknown): Match | string {
  if (!body || typeof body !== "object") return "body missing";
  const b = body as Record<string, unknown>;
  const mid = String(b.mid ?? "");
  if (!/^[a-z0-9]{4,20}$/.test(mid)) return "bad mid";
  const mode = b.mode === "online" ? "online" : "local";
  const rounds = Math.max(1, Math.min(20, Math.floor(Number(b.rounds) || 0)));
  if (!Array.isArray(b.players) || b.players.length < 2 || b.players.length > 6) return "need 2-6 players";
  const int = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const players: MatchPlayer[] = b.players.map((x: any, i: number) => ({
    name: String(x?.name ?? "?").slice(0, 20),
    slug: typeof x?.slug === "string" && SLUG.test(x.slug) ? x.slug : null,
    human: !!x?.human,
    place: int(x?.place ?? i + 1, 6) || i + 1,
    score: int(x?.score, 1000),
    wins: int(x?.wins, 20),
    kills: int(x?.kills, 1000),
  }));
  if (!players.some((p) => p.human)) return "no human players";
  // kills between two human players: [killerSlug, victimSlug, count], only for slugs that played this match
  const inMatch = new Set(players.filter((p) => p.human && p.slug).map((p) => p.slug as string));
  const kx = (Array.isArray(b.kx) ? b.kx : []).slice(0, 30).filter((k: any) => Array.isArray(k) && inMatch.has(k[0]) && inMatch.has(k[1]) && k[0] !== k[1])
    .map((k: any) => [k[0], k[1], int(k[2], 200)] as [string, string, number]).filter((k) => k[2] > 0);
  return { mid, mode, rounds, at: Date.now(), players, ...(kx.length ? { kx } : {}) };
}

// shop prices, to count purchases made before spending was tracked
const PRICES: Record<string, number> = {"lx_heli": 18000, "lx_yacht": 20000, "lx_rolex": 15000, "bd_p_hdz": 1500, "bd_p_sdp": 1500, "bd_p_mozemo": 1500, "bd_p_most": 1500, "bd_p_dp": 1500, "bd_p_hss": 1500, "bd_p_ids": 1500, "bd_p_rf": 1500, "bd_lgbt": 1500, "bd_qplus": 1500, "bd_trans": 1500, "bd_bi": 1500, "bd_nb": 1500, "bd_hr": 1000, "bd_sibenik": 1000, "bd_funcut": 1000, "bd_dinamo": 1000, "bd_hajduk": 1000, "bd_mihovil": 1000, "bd_katedrala": 1000, "sk_boat": 180, "sk_dog": 180, "bd_boat": 120, "bd_dog": 120, "sk_dragon": 5000, "sk_galaxy": 3500, "sk_bolt": 3000, "sz_pumpkin": 1200, "sz_snow": 1200, "sz_love": 1200, "sz_sun": 1200, "pr_goldname": 2500, "pr_title": 2000, "pr_entrance": 2000, "bg_space": 3000, "bg_lava": 3000, "bg_sea": 3000, "pr_room": 1500, "pr_vip": 4000, "pr_tomb": 1800, "te_fire": 220, "te_spark": 180, "te_hearts": 160, "te_bubble": 140, "ds_confetti": 150, "ds_ghost": 170, "ds_poop": 150, "ds_boom": 200, "vs_fanfare": 140, "vs_fart": 120, "vs_horn": 160, "vs_laugh": 140, "sk_diamond": 900, "bd_comet": 700, "sk_neon": 120, "sk_dash": 90, "sk_pixel": 90, "sk_rainbow": 220, "sk_gold": 320, "sk_dildo": 150, "sk_vag": 160, "sk_boobs": 160, "sk_condom": 160, "sk_hairy": 170, "bd_bolt": 60, "bd_star": 100, "bd_skull": 140, "bd_gem": 180, "bd_crown": 300, "bd_ucross": 200, "bd_vag": 120, "bd_boobs": 120, "bd_hairy": 130, "bd_condom": 120, "fastS": 110, "slowS": 110, "thinS": 110, "ghostS": 110, "wrapS": 110, "jumpS": 110, "slowO": 170, "thickO": 170, "revO": 170, "sqO": 170};
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

async function stats() {
  const accStore = getStore({ name: "vijuga-accounts", consistency: "strong" });
  const mStore = getStore({ name: "vijuga-matches", consistency: "strong" });
  const [{ blobs: accKeys }, { blobs: mKeys }] = await Promise.all([accStore.list(), mStore.list()]);
  const accounts = ((await Promise.all(accKeys.map((k) => accStore.get(k.key, { type: "json" })))) as (Account | null)[]).filter((a): a is Account => !!a);
  const matches = ((await Promise.all(mKeys.map((k) => mStore.get(k.key, { type: "json" })))) as (Match | null)[]).filter((m): m is Match => !!m);
  matches.sort((a, b) => b.at - a.at);

  const now = Date.now(), DAY = 86400000;
  const days: { day: string; matches: number; players: number }[] = [];
  for (let i = 13; i >= 0; i--) days.push({ day: dayKey(now - i * DAY), matches: 0, players: 0 });
  const dayIdx = Object.fromEntries(days.map((d, i) => [d.day, i]));
  const activeByDay: Record<string, Set<string>> = Object.create(null);
  for (const m of matches) {
    const k = dayKey(m.at);
    if (k in dayIdx) days[dayIdx[k]].matches++;
    for (const p of m.players) if (p.human) (activeByDay[k] ||= new Set()).add(p.slug || "anon:" + p.name);
  }
  for (const d of days) d.players = activeByDay[d.day]?.size || 0;

  // per player, from the match log (accurate for matches recorded since logging began) plus the profile counters
  const per: Record<string, { logged: number; firsts: number; podiums: number; rounds: number; kills: number; lastPlayed: number; online: number }> = Object.create(null);
  for (const m of matches) for (const p of m.players) {
    if (!p.human || !p.slug) continue;
    const r = (per[p.slug] ||= { logged: 0, firsts: 0, podiums: 0, rounds: 0, kills: 0, lastPlayed: 0, online: 0 });
    r.logged++; if (p.place === 1) r.firsts++; if (p.place <= 3) r.podiums++; r.rounds += p.wins; r.kills += p.kills; r.lastPlayed = Math.max(r.lastPlayed, m.at); if (m.mode === "online") r.online++;
  }
  const invites: Record<string, number> = Object.create(null);
  for (const a of accounts) if (a.invitedBy) invites[a.invitedBy] = (invites[a.invitedBy] || 0) + 1;
  const players = accounts.map((a) => {
    const r = per[a.slug] || { logged: 0, firsts: 0, podiums: 0, rounds: 0, kills: 0, lastPlayed: 0, online: 0 };
    const played = Math.max(Number(a.matches) || 0, r.logged);
    return {
      slug: a.slug, name: a.name, color: a.color ?? 0, badge: a.eq?.badge || "bd_none", skin: a.eq?.skin || "sk_none",
      coins: Number(a.coins) || 0, matches: played, wins: Math.max(Number(a.wins) || 0, r.firsts),
      winRate: played ? Math.round((100 * Math.max(Number(a.wins) || 0, r.firsts)) / played) : 0,
      podiums: r.podiums, roundsWon: r.rounds, kills: Math.max(Number(a.kills) || 0, r.kills), online: r.online,
      items: Math.max(0, (Array.isArray(a.owned) ? a.owned.filter((x) => x !== "sk_none" && x !== "bd_none").length : 0)),
      spent: Math.max(Number(a.spent) || 0, (Array.isArray(a.owned) ? a.owned : []).reduce((s, id) => s + (PRICES[id] || 0), 0)), purchases: Math.max(Number(a.purchases) || 0, (Array.isArray(a.owned) ? a.owned : []).filter((id) => PRICES[id]).length),
      owned: Array.isArray(a.owned) ? a.owned : [], inv: a.inv || {}, eq: a.eq || {}, playMs: Number(a.playMs) || 0, siteMs: Number(a.siteMs) || 0,
      trollsSent: Number(a.trollsSent) || 0, trollsGot: Number(a.trollsGot) || 0,
      created: a.created || 0, lastSeen: Math.max(a.updatedAt || 0, r.lastPlayed), invitedBy: a.invitedBy || null, invited: invites[a.slug] || 0,
    };
  }).sort((x, y) => y.matches - x.matches || y.wins - x.wins);

  const skins: Record<string, number> = Object.create(null), badges: Record<string, number> = Object.create(null);
  for (const p of players) { skins[p.skin] = (skins[p.skin] || 0) + 1; badges[p.badge] = (badges[p.badge] || 0) + 1; }
  // how many players own each item (bought at least once)
  const owned: Record<string, number> = Object.create(null);
  for (const a of accounts) for (const id of new Set(Array.isArray(a.owned) ? a.owned : [])) if (id !== "sk_none" && id !== "bd_none") owned[id] = (owned[id] || 0) + 1;
  const top = (key: keyof (typeof players)[number]) => [...players].filter((p) => Number(p[key]) > 0).sort((x, y) => Number(y[key]) - Number(x[key])).slice(0, 5).map((p) => ({ name: p.name, slug: p.slug, value: Number(p[key]) }));
  // player of the week: wins, podiums and kills in the last 7 days
  const wk: Record<string, { name: string; slug: string; firsts: number; matches: number; podiums: number; kills: number; score: number }> = Object.create(null);
  for (const m of matches) if (m.at > now - 7 * DAY) for (const p of m.players) {
    if (!p.human || !p.slug) continue;
    const r = (wk[p.slug] ||= { name: p.name, slug: p.slug, firsts: 0, matches: 0, podiums: 0, kills: 0, score: 0 });
    r.matches++; if (p.place === 1) r.firsts++; if (p.place <= 3) r.podiums++; r.kills += p.kills;
  }
  for (const r of Object.values(wk)) { r.score = r.firsts * 5 + r.podiums * 2 + r.kills * 0.3 + r.matches * 0.5; const acc = accounts.find((a) => a.slug === r.slug); if (acc) r.name = acc.name; }
  const weekly = Object.values(wk).sort((a, b) => b.score - a.score)[0] || null;
  const leaders = { playMs: top("playMs"), spent: top("spent"), items: top("items"), trollsSent: top("trollsSent"), trollsGot: top("trollsGot"), invited: top("invited"), kills: top("kills") };

  // ranked: online matches with at least two logged-in humans. Elo from pairwise places, plus head-to-head records.
  const nameOf = (slug: string) => accounts.find((a) => a.slug === slug)?.name || slug;
  const elo: Record<string, { r: number; games: number; best: number }> = Object.create(null);
  const h2h: Record<string, { a: string; b: string; games: number; aw: number; bw: number }> = Object.create(null);
  const pairKey = (x: string, y: string) => (x < y ? x + "|" + y : y + "|" + x);
  for (const m of [...matches].reverse()) {
    if (m.mode !== "online") continue;
    const hs = m.players.filter((p) => p.human && p.slug) as (MatchPlayer & { slug: string })[];
    if (new Set(hs.map((p) => p.slug)).size < 2) continue;
    for (const p of hs) elo[p.slug] ||= { r: 1000, games: 0, best: 1000 };
    const delta: Record<string, number> = Object.create(null);
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const A = hs[i], B = hs[j]; if (A.slug === B.slug) continue;
      const ea = 1 / (1 + 10 ** ((elo[B.slug].r - elo[A.slug].r) / 400)), sa = A.place < B.place ? 1 : A.place > B.place ? 0 : 0.5;
      const k = 32 / (hs.length - 1);
      delta[A.slug] = (delta[A.slug] || 0) + k * (sa - ea); delta[B.slug] = (delta[B.slug] || 0) - k * (sa - ea);
      const key = pairKey(A.slug, B.slug), [a, b2] = key.split("|");
      const h = (h2h[key] ||= { a, b: b2, games: 0, aw: 0, bw: 0 }); h.games++;
      const winner = A.place < B.place ? A.slug : B.place < A.place ? B.slug : null;
      if (winner === a) h.aw++; else if (winner === b2) h.bw++;
    }
    for (const [sl, d] of Object.entries(delta)) { const e = elo[sl]; e.r += d; e.games++; e.best = Math.max(e.best, e.r); }
  }
  const ranked = Object.entries(elo).map(([slug, e]) => ({ slug, name: nameOf(slug), elo: Math.round(e.r), best: Math.round(e.best), games: e.games })).sort((a, b) => b.elo - a.elo);
  const rivals = Object.values(h2h).sort((x, y) => y.games - x.games).slice(0, 15).map((h) => ({ a: h.a, aName: nameOf(h.a), b: h.b, bName: nameOf(h.b), games: h.games, aw: h.aw, bw: h.bw }));
  const killPairs: Record<string, number> = Object.create(null);
  for (const m of matches) for (const [k, v, n] of m.kx || []) killPairs[k + ">" + v] = (killPairs[k + ">" + v] || 0) + n;
  const kills2 = Object.entries(killPairs).map(([k, n]) => { const [a, b2] = k.split(">"); return { killer: a, killerName: nameOf(a), victim: b2, victimName: nameOf(b2), n }; }).sort((x, y) => y.n - x.n).slice(0, 15);
  const tStore = getStore({ name: "vijuga-trolls", consistency: "strong" });
  const { blobs: tKeys } = await tStore.list();
  const trollPairs = ((await Promise.all(tKeys.map(async (k) => { const [a, b2] = k.key.split("/"); const v = (await tStore.get(k.key, { type: "json" })) as { n?: number } | null; return { from: a, fromName: nameOf(a), to: b2, toName: nameOf(b2), n: Number(v?.n) || 0 }; }))) as { from: string; fromName: string; to: string; toName: string; n: number }[])
    .filter((t) => t.n > 0).sort((x, y) => y.n - x.n).slice(0, 15);
  const facts: string[] = [];
  if (ranked[0]) facts.push(`👑 ${ranked[0].name} vodi rang listu s ${ranked[0].elo} bodova`);
  if (kills2[0]) facts.push(`💀 Najveća žrtva: ${kills2[0].killerName} → ${kills2[0].victimName}, ${kills2[0].n} rušenja`);
  if (kills2[1]) facts.push(`🔪 ${kills2[1].killerName} → ${kills2[1].victimName}: ${kills2[1].n} rušenja`);
  if (trollPairs[0]) facts.push(`🤡 Najveći troll: ${trollPairs[0].fromName} → ${trollPairs[0].toName}, ${trollPairs[0].n} psina`);
  for (const r of rivals.slice(0, 3)) if (r.games >= 2) facts.push(r.aw === r.bw ? `⚔️ ${r.aName} i ${r.bName}: ${r.games} susreta, izjednačeno ${r.aw}:${r.bw}` : `⚔️ ${r.aw > r.bw ? r.aName : r.bName} vodi protiv ${r.aw > r.bw ? r.bName : r.aName} ${Math.max(r.aw, r.bw)}:${Math.min(r.aw, r.bw)}`);
  const kTop = players.filter((p) => p.kills > 0).sort((x, y) => y.kills - x.kills)[0]; if (kTop) facts.push(`🎯 Najviše rušenja: ${kTop.name} (${kTop.kills})`);
  const pTop = players.filter((p) => p.playMs > 0).sort((x, y) => y.playMs - x.playMs)[0]; if (pTop) facts.push(`⏱️ Najviše igre: ${pTop.name}, ${Math.round(pTop.playMs / 60000)} min`);
  const rich = [...players].sort((x, y) => y.coins - x.coins)[0]; if (rich && rich.coins > 0) facts.push(`💰 Najbogatiji: ${rich.name} (${rich.coins} 🪙)`);
  if (weekly) facts.push(`🏆 Igrač tjedna: ${weekly.name}`);

  return {
    ranked, rivals, killPairs: kills2, trollPairs, facts,
    generatedAt: now,
    totals: {
      players: accounts.length,
      newPlayers7d: accounts.filter((a) => (a.created || 0) > now - 7 * DAY).length,
      activePlayers7d: new Set(matches.filter((m) => m.at > now - 7 * DAY).flatMap((m) => m.players.filter((p) => p.human).map((p) => p.slug || "anon:" + p.name))).size,
      matches: matches.length,
      matchesOnline: matches.filter((m) => m.mode === "online").length,
      matchesLocal: matches.filter((m) => m.mode === "local").length,
      matches7d: matches.filter((m) => m.at > now - 7 * DAY).length,
      roundsPlayed: matches.reduce((s, m) => s + m.rounds, 0),
      playerMatches: players.reduce((s, p) => s + p.matches, 0),
      coinsHeld: players.reduce((s, p) => s + p.coins, 0),
      kills: players.reduce((s, p) => s + p.kills, 0),
      invitedPlayers: accounts.filter((a) => a.invitedBy).length,
      coinsSpent: players.reduce((s, p) => s + p.spent, 0),
      purchases: players.reduce((s, p) => s + Math.max(p.purchases, p.items), 0),
      itemsOwned: players.reduce((s, p) => s + p.items, 0),
      playMs: players.reduce((s, p) => s + p.playMs, 0),
      siteMs: players.reduce((s, p) => s + p.siteMs, 0),
      trolls: players.reduce((s, p) => s + p.trollsSent, 0),
    },
    days,
    players,
    recent: matches.slice(0, 25).map((m) => ({ mid: m.mid, at: m.at, mode: m.mode, rounds: m.rounds, players: [...m.players].sort((a, b) => a.place - b.place).map((p) => ({ name: p.name, human: p.human, place: p.place, score: p.score, kills: p.kills })) })),
    skins, badges, owned, leaders, weekly,
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  if (url.pathname.endsWith("/troll")) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const from = String(b?.from ?? ""), to = String(b?.to ?? "");
    if (!SLUG.test(from) || !SLUG.test(to) || from === to) return json({ error: "bad pair" }, 400);
    const acc = getStore({ name: "vijuga-accounts", consistency: "strong" });
    const fa = (await acc.get(from, { type: "json" })) as Record<string, unknown> | null;
    if (!fa || !(await acc.get(to))) return json({ error: "unknown player" }, 404);
    if (fa.pinHash && fa.pinHash !== b?.auth) return json({ error: "auth" }, 403);
    const t = getStore({ name: "vijuga-trolls", consistency: "strong" }), key = `${from}/${to}`;
    const cur = ((await t.get(key, { type: "json" })) as { n?: number } | null) || {};
    await t.setJSON(key, { n: (Number(cur.n) || 0) + 1, last: Date.now() });
    return json({ ok: true });
  }
  if (url.pathname.endsWith("/stats")) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json(await stats());
  }
  if (req.method === "DELETE") {
    // Maintenance only: remove a match (e.g. a test) with the admin key set in the site's environment.
    const given = req.headers.get("x-admin-key") || "";
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(given)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!given || digest !== ADMIN_KEY_SHA256) return json({ error: "forbidden" }, 403);
    const mid = context.params.mid;
    if (!mid || !/^[a-z0-9]{4,20}$/.test(mid)) return json({ error: "bad mid" }, 400);
    await getStore({ name: "vijuga-matches", consistency: "strong" }).delete(mid);
    return json({ ok: true });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const m = cleanMatch(raw);
  if (typeof m === "string") return json({ error: m }, 400);
  // the reporter must be a logged-in player of this match (PIN checked)
  const rep = String(raw?.slug ?? "");
  if (!SLUG.test(rep) || !m.players.some((p) => p.slug === rep)) return json({ error: "reporter not in match" }, 403);
  const racc = (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(rep, { type: "json" })) as Record<string, unknown> | null;
  if (!racc || (racc.pinHash && racc.pinHash !== raw?.auth)) return json({ error: "auth" }, 403);
  const store = getStore({ name: "vijuga-matches", consistency: "strong" });
  const { modified } = await store.setJSON(m.mid, m, { onlyIfNew: true });
  return json({ ok: true, stored: modified !== false });
};

export const config: Config = { path: ["/api/matches", "/api/matches/:mid", "/api/stats", "/api/troll"] };
