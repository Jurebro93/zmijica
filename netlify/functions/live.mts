// Everyday live data for Vijuga's "live" icons, fetched here once for everybody and kept for a few minutes, so a
// hundred players make a handful of requests to the sources. Every source is public and needs no key:
//   sea temperature and waves, wind gusts (bura), sunrise/sunset ... Open-Meteo (forecast, marine, air quality)
//   exchange rates ... Frankfurter (European Central Bank)        earthquakes ... EMSC
//   ISS position ... wheretheiss.at                               Formula 1 ... Jolpica (Ergast)
//   name days ... abalin.net                                      public holidays ... Nager.Date
//   SuperSport HNL fixtures, results and table ... hnl.hr, the league's own site (Hajduk, Dinamo)
// Šibenik plays in a league no open source publishes, so an admin enters its match (and the live score) in the game.
// GET  /api/live                  -> { at, sea, wind, sun, air, fx, quake, iss, f1, day, hnl, clubs }
// POST /api/live/club {slug, auth, club, next?, live?, last?, pos?, league?}  -> admin edits a hand-kept club
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { roleOf } from "./roles.mts";
import { account, cas, pinGate } from "./guard.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const SLUG = /^[a-z0-9-]{1,40}$/;
const MIN = 60_000, HOUR = 60 * MIN;
const store = () => getStore({ name: "vijuga-live", consistency: "strong" });
const UA = "Mozilla/5.0 (compatible; VijugaGame/1.0; +https://zmijica.onrender.com)";

// a function has about 10 s: every source gets 6 s (they are asked in parallel), a slow one is simply asked again later
async function get(url: string, type: "json" | "text" = "json", ms = 6000): Promise<any> {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": UA, accept: type === "json" ? "application/json" : "text/html" }, redirect: "follow" }); if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status); return type === "json" ? await r.json() : await r.text(); }
  finally { clearTimeout(t); }
}

// ---- places
export const SEA = { sib: [43.70, 15.85], st: [43.48, 16.40], zd: [44.10, 15.18], du: [42.63, 18.07], pu: [44.85, 13.80] } as Record<string, number[]>;
export const GUST = { senj: [44.99, 14.90], st: [43.508, 16.44], sib: [43.735, 15.895] } as Record<string, number[]>;
const AIR = { zg: [45.815, 15.982], sib: [43.735, 15.895] } as Record<string, number[]>;
const many = (o: Record<string, number[]>) => ({ lat: Object.values(o).map((p) => p[0]).join(","), lon: Object.values(o).map((p) => p[1]).join(",") });
const arr = (j: unknown) => (Array.isArray(j) ? j : [j]) as any[];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- the sources
const SOURCES: Record<string, { ttl: number; load: () => Promise<unknown> }> = {
  sea: { ttl: 30 * MIN, load: async () => { const m = many(SEA); const j = arr(await get(`https://marine-api.open-meteo.com/v1/marine?latitude=${m.lat}&longitude=${m.lon}&current=sea_surface_temperature,wave_height`)); const o: Record<string, unknown> = {}; Object.keys(SEA).forEach((k, i) => { const c = j[i] && j[i].current; if (c && num(c.sea_surface_temperature) != null) o[k] = { t: c.sea_surface_temperature, wave: num(c.wave_height) }; }); return o; } },
  wind: { ttl: 15 * MIN, load: async () => { const m = many(GUST); const j = arr(await get(`https://api.open-meteo.com/v1/forecast?latitude=${m.lat}&longitude=${m.lon}&current=wind_gusts_10m,wind_direction_10m&daily=sunrise,sunset&timezone=Europe%2FZagreb&forecast_days=1`)); const o: Record<string, unknown> = {}; Object.keys(GUST).forEach((k, i) => { const c = j[i] && j[i].current; if (c && num(c.wind_gusts_10m) != null) o[k] = { g: c.wind_gusts_10m, dir: num(c.wind_direction_10m) }; }); const d = j[2] && j[2].daily; if (d) o.sun = { rise: d.sunrise && d.sunrise[0], set: d.sunset && d.sunset[0] }; return o; } },
  air: { ttl: 30 * MIN, load: async () => { const m = many(AIR); const j = arr(await get(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${m.lat}&longitude=${m.lon}&current=european_aqi,uv_index,birch_pollen,grass_pollen,ragweed_pollen`)); const o: Record<string, unknown> = {}; Object.keys(AIR).forEach((k, i) => { const c = j[i] && j[i].current; if (c) o[k] = { aqi: num(c.european_aqi), uv: num(c.uv_index), pollen: Math.round((num(c.birch_pollen) || 0) + (num(c.grass_pollen) || 0) + (num(c.ragweed_pollen) || 0)) }; }); return o; } },
  fx: { ttl: 6 * HOUR, load: async () => { const j = await get("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,CHF,GBP"); return { date: j.date, USD: num(j.rates && j.rates.USD), CHF: num(j.rates && j.rates.CHF), GBP: num(j.rates && j.rates.GBP) }; } },
  quake: { ttl: 10 * MIN, load: async () => { const j = await get("https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=1&minlat=42.3&maxlat=46.6&minlon=13.4&maxlon=19.5&orderby=time"); const p = j.features && j.features[0] && j.features[0].properties; return p ? { mag: num(p.mag), place: String(p.flynn_region || ""), lat: num(p.lat), lon: num(p.lon), at: Date.parse(p.time) || null } : null; } },
  iss: { ttl: 1 * MIN, load: async () => { const j = await get("https://api.wheretheiss.at/v1/satellites/25544"); return { lat: num(j.latitude), lon: num(j.longitude), alt: num(j.altitude), v: num(j.velocity), at: Date.now() }; } },
  f1: { ttl: 6 * HOUR, load: async () => { const j = await get("https://api.jolpi.ca/ergast/f1/current/next.json"); const r = j.MRData && j.MRData.RaceTable && j.MRData.RaceTable.Races && j.MRData.RaceTable.Races[0]; return r ? { name: String(r.raceName || ""), country: String((r.Circuit && r.Circuit.Location && r.Circuit.Location.country) || ""), city: String((r.Circuit && r.Circuit.Location && r.Circuit.Location.locality) || ""), at: Date.parse(r.date + "T" + (r.time || "12:00:00Z")) || null } : null; } },
  day: { ttl: 3 * HOUR, load: async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb" }).format(Date.now());
    const [nd, hol] = await Promise.allSettled([get("https://nameday.abalin.net/api/V2/today/hr?timezone=Europe/Zagreb"), get(`https://date.nager.at/api/v3/PublicHolidays/${today.slice(0, 4)}/HR`)]);
    const names = nd.status === "fulfilled" && nd.value && nd.value.data ? String(nd.value.data.hr || nd.value.data.name || "") : "";
    const list = hol.status === "fulfilled" && Array.isArray(hol.value) ? hol.value : [];
    const h = list.find((x: any) => x.date === today) || null, nx = list.find((x: any) => String(x.date) > today) || null;
    return { date: today, names: names === "n/a" ? "" : names.slice(0, 120), holiday: h ? String(h.localName || h.name).slice(0, 80) : "", next: nx ? { date: String(nx.date).slice(0, 10), name: String(nx.localName || nx.name).slice(0, 60) } : null };
  } },
  fuel: { ttl: 6 * HOUR, load: async () => parseFuel(await get("https://www.hak.hr/info/cijene-goriva/", "text", 9000)) },
  hnl: { ttl: 30 * MIN, load: async () => {
    const [home, fx] = await Promise.all([get("https://hnl.hr/", "text"), get("https://hnl.hr/supersport-hnl/raspored-i-rezultati/", "text")]);
    return { table: parseTable(home), matches: parseFixtures(fx) };
  } },
};

// ---- HAK's fuel prices: a table per fuel (one row per company and product: min, max, median EUR/l). The price of the day
// is the most common median of the fuel's rows (the plain products all sit on the government's cap)
export function parseFuel(html: string) {
  const fuel = (id: string) => {
    const i = html.indexOf(`id="${id}"`); if (i < 0) return null;
    const t = html.slice(i, html.indexOf("</table>", i)), med: number[] = [];
    for (const m of t.matchAll(/<tr>\s*<td>[\s\S]*?<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>[\s\S]*?<\/td>\s*<td>\s*([0-9]+,[0-9]+)\s*€/g)) { const v = Number(m[1].replace(",", ".")); if (v > 0.3 && v < 5) med.push(v); }
    if (!med.length) return null;
    const n = new Map<number, number>(); for (const v of med) n.set(v, (n.get(v) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  };
  const es = fuel("div_eurosuper95"), dz = fuel("div_eurodizel"), lpg = fuel("div_autoplin");
  if (es == null && dz == null) return null;
  const d = /Zadnje ažurirano:\s*([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})/.exec(html);
  return { es, dz, lpg, date: d ? d[1] : null };
}

// ---- hnl.hr pages
const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
export function parseTable(html: string) {
  const i = html.indexOf(">Bod<"); if (i < 0) return [];
  const end = html.indexOf("</table>", i); const part = html.slice(i, end < 0 ? undefined : end);
  const out: { pos: number; club: string; p: number; w: number; d: number; l: number; gf: number; ga: number; gd: number; pts: number }[] = [];
  for (const row of part.split(/<tr[^>]*>/).slice(1)) {
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1])); if (c.length < 10) continue;
    const n = (s: string) => parseInt(s.replace("+", ""), 10) || 0;
    out.push({ pos: n(c[0]), club: c[1], p: n(c[2]), w: n(c[3]), d: n(c[4]), l: n(c[5]), gf: n(c[6]), ga: n(c[7]), gd: n(c[8]), pts: n(c[9]) });
  }
  return out.filter((r) => r.pos > 0 && r.club).slice(0, 20);
}
// local Zagreb wall time -> epoch ms
export function zagreb(y: number, mo: number, d: number, h: number, mi: number) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zagreb", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess - (shown - guess);
}
export function parseFixtures(html: string) {
  const out: { at: number; round: number; home: string; away: string; hs: number | null; as: number | null; venue: string }[] = [];
  let round = 0;
  for (const row of html.split(/<tr/).slice(1)) {
    const th = /<th[^>]*>\s*(\d+)\.\s*kolo/.exec(row); if (th) { round = +th[1]; continue; }
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]); if (c.length < 6) continue;
    const dt = /(\d{2})\.(\d{2})\.(\d{4})\.\s*(\d{2}):(\d{2})/.exec(c[0]); if (!dt) continue;
    const venue = (/<div class="mjesto">([\s\S]*?)<\/div>/.exec(c[0]) || [])[1] || "";
    const sc = (s: string) => { const t = strip(s); return /^\d+$/.test(t) ? +t : null; };
    out.push({ at: zagreb(+dt[3], +dt[2], +dt[1], +dt[4], +dt[5]), round, home: strip(c[1]), away: strip(c[5]), hs: sc(c[2]), as: sc(c[4]), venue: strip(venue).slice(0, 60) });
  }
  return out;
}
// what a supporter's icon needs: the next match, the live one (score and minute), the last result, the place in the table
export const CLUBS: Record<string, { name: string; hnl?: string }> = { hajduk: { name: "Hajduk", hnl: "Hajduk" }, dinamo: { name: "Dinamo", hnl: "Dinamo" }, sibenik: { name: "Šibenik" } };
export function minuteOf(at: number, now: number) { const el = (now - at) / MIN; return el < 0 ? 0 : el < 46 ? Math.ceil(el) : el < 61 ? "HT" : el < 112 ? Math.min(90, Math.ceil(el - 15)) : "90+"; }
export function clubView(key: string, matches: ReturnType<typeof parseFixtures>, table: ReturnType<typeof parseTable>, now: number) {
  const nm = CLUBS[key].hnl!; const mine = matches.filter((m) => m.home === nm || m.away === nm).sort((a, b) => a.at - b.at);
  const side = (m: (typeof mine)[number]) => { const home = m.home === nm; return { at: m.at, opp: home ? m.away : m.home, home, venue: m.venue, round: m.round }; };
  const liveM = mine.find((m) => m.at <= now && now < m.at + 130 * MIN);
  const next = mine.find((m) => m.at > now);
  const done = mine.filter((m) => m.hs != null && m.as != null && m.at + 100 * MIN <= now && m !== liveM);
  const lastM = done[done.length - 1];
  const t = table.find((r) => r.club === nm);
  const res = (gf: number, ga: number) => (gf > ga ? "W" : gf < ga ? "L" : "D");
  return {
    name: CLUBS[key].name, league: "SuperSport HNL", pos: t ? t.pos : null, pts: t ? t.pts : null, played: t ? t.p : null,
    next: next ? side(next) : null,
    live: liveM ? { ...side(liveM), gf: liveM.home === nm ? liveM.hs : liveM.as, ga: liveM.home === nm ? liveM.as : liveM.hs, min: minuteOf(liveM.at, now) } : null,
    last: lastM ? { ...side(lastM), gf: lastM.home === nm ? lastM.hs : lastM.as, ga: lastM.home === nm ? lastM.as : lastM.hs, res: res(lastM.home === nm ? lastM.hs! : lastM.as!, lastM.home === nm ? lastM.as! : lastM.hs!) } : null,
  };
}

type Cache = Record<string, { at: number; data: unknown; err?: string }>;
// a match on or about to start: the league pages are read every minute instead of every half hour
function hnlTtl(c: Cache, now: number) {
  const ms = ((c.hnl && c.hnl.data) as { matches?: { at: number; home: string; away: string }[] } | undefined)?.matches || [];
  return ms.some((m) => (m.home === "Hajduk" || m.home === "Dinamo" || m.away === "Hajduk" || m.away === "Dinamo") && m.at - 10 * MIN <= now && now < m.at + 130 * MIN) ? MIN : SOURCES.hnl.ttl;
}
export async function refresh(c: Cache, now = Date.now()) {
  const stale = Object.keys(SOURCES).filter((k) => !c[k] || now - c[k].at > (k === "hnl" ? hnlTtl(c, now) : SOURCES[k].ttl));
  const got = await Promise.allSettled(stale.map((k) => SOURCES[k].load()));
  stale.forEach((k, i) => { const g = got[i]; if (g.status === "fulfilled" && g.value != null) c[k] = { at: now, data: g.value }; else if (c[k]) c[k] = { ...c[k], at: now - SOURCES[k].ttl + 2 * MIN, err: String(g.status === "rejected" ? g.reason : "empty").slice(0, 120) }; else c[k] = { at: now - SOURCES[k].ttl + 2 * MIN, data: null, err: String(g.status === "rejected" ? g.reason : "empty").slice(0, 120) }; }); // a failing source is asked again in 2 minutes, the last good answer stays
  return stale.length > 0;
}
type Manual = { name: string; league: string; pos: number | null; next: { at: number; opp: string; home: boolean } | null; live: { at: number; opp: string; home: boolean; gf: number; ga: number; min?: string | number } | null; last: { at: number; opp: string; home: boolean; gf: number; ga: number; res: string } | null; by?: string; updated?: number };

export function view(c: Cache, manual: Record<string, Manual>, now = Date.now()) {
  const d = (k: string) => (c[k] ? c[k].data : null) as any;
  const hnl = d("hnl") || { table: [], matches: [] };
  const clubs: Record<string, unknown> = {};
  for (const k of Object.keys(CLUBS)) {
    if (CLUBS[k].hnl) clubs[k] = clubView(k, hnl.matches || [], hnl.table || [], now);
    else { const m = manual[k]; clubs[k] = m ? { ...m, live: m.live ? { ...m.live, min: m.live.min ?? minuteOf(m.live.at, now) } : null, next: m.next && m.next.at > now - 130 * MIN ? m.next : null } : { name: CLUBS[k].name, league: "Prva NL", pos: null, next: null, live: null, last: null }; }
  }
  const w = d("wind") || {};
  return { at: now, sea: d("sea"), wind: { senj: w.senj, st: w.st, sib: w.sib }, sun: w.sun || null, air: d("air"), fx: d("fx"), quake: d("quake"), iss: d("iss"), f1: d("f1"), day: d("day"), fuel: d("fuel"), hnl: { table: hnl.table || [] }, clubs };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const s = store();
  if (req.method === "GET") {
    const c = ((await s.get("cache", { type: "json" })) as Cache | null) || {};
    if (await refresh(c)) await s.setJSON("cache", c);
    const manual = ((await s.get("manual", { type: "json" })) as Record<string, Manual> | null) || {};
    return Response.json(view(c, manual), { headers: { ...cors, "cache-control": "public, max-age=20", "netlify-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=60" } });
  }
  if (req.method === "POST" && context.params.action === "club") {
    const b = (await req.json().catch(() => null)) as Record<string, any> | null; if (!b) return Response.json({ error: "body missing" }, { status: 400, headers: cors });
    const slug = String(b.slug ?? ""); if (!SLUG.test(slug)) return Response.json({ error: "auth" }, { status: 403, headers: cors });
    const acc = await account(slug), role = await roleOf(slug);
    if (!acc || !["master", "admin"].includes(role)) return Response.json({ error: "admins only" }, { status: 403, headers: cors });
    const g = await pinGate(req, context, slug, acc.pinHash, b.auth, { requirePin: true });
    if (!g.ok) return Response.json(g.status === 429 ? { error: g.error, wait: g.wait } : { error: "admins only" }, { status: g.status === 429 ? 429 : 403, headers: cors });
    const key = String(b.club ?? ""); if (!CLUBS[key] || CLUBS[key].hnl) return Response.json({ error: "bad club" }, { status: 400, headers: cors });
    const txt = (v: unknown, n: number) => String(v ?? "").replace(/[<>]/g, "").slice(0, n);
    const int = (v: unknown, lo: number, hi: number) => { const x = Math.floor(Number(v)); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo; };
    const side = (v: any) => v && typeof v === "object" ? { at: int(v.at, 0, 4102444800000), opp: txt(v.opp, 30), home: !!v.home } : null;
    let cur = {} as Manual;
    await cas<Record<string, Manual>>(s, "manual", (m) => {
      const manual = m || {};
      cur = { ...(manual[key] || { name: CLUBS[key].name, league: "Prva NL", pos: null, next: null, live: null, last: null }) };
      if ("next" in b) cur.next = side(b.next);
      if ("live" in b) cur.live = b.live ? { ...side(b.live)!, gf: int(b.live.gf, 0, 99), ga: int(b.live.ga, 0, 99) } : null;
      if ("last" in b) cur.last = b.last ? { ...side(b.last)!, gf: int(b.last.gf, 0, 99), ga: int(b.last.ga, 0, 99), res: int(b.last.gf, 0, 99) > int(b.last.ga, 0, 99) ? "W" : int(b.last.gf, 0, 99) < int(b.last.ga, 0, 99) ? "L" : "D" } : null;
      if ("pos" in b) cur.pos = b.pos == null || b.pos === "" ? null : int(b.pos, 1, 30);
      if ("league" in b) cur.league = txt(b.league, 30) || "Prva NL";
      cur.by = slug; cur.updated = Date.now(); manual[key] = cur;
      return manual;
    });
    return Response.json({ club: cur }, { headers: cors });
  }
  return Response.json({ error: "unknown" }, { status: 404, headers: cors });
};

export const config: Config = { path: ["/api/live", "/api/live/:action"] };
