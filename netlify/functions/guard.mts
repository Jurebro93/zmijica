// Shared server helpers for Vijuga's functions (a module, not a function: it has no route, like stripe.mts).
//  cas()      read-modify-write of one blob that survives concurrent writers (ETag compare-and-swap, retried)
//  pinGate()  EVERY PIN check goes through one failure limiter: per IP+account, per IP, and a looser cap per account
//  hit()      a sliding-window rate limit for everything else (chat, push, account creation)
//  digest()   one blob that mirrors many (public profiles, the match log, troll counts), so a poll reads 1 blob, not N
import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export const SLUG = /^[a-z0-9-]{1,40}$/;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Store = ReturnType<typeof getStore>;
type Ctx = Partial<Pick<Context, "ip" | "waitUntil">> | undefined;

// ---- compare-and-swap
// fn gets the current value (null when the key does not exist) and returns the value to write, or undefined to write
// nothing. It can run more than once (after a conflict), so it must not have side effects: do those after cas() returns.
export async function cas<T>(store: Store, key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>, tries = 10): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const next = await fn(cur ? (cur.data as T) : null);
    if (next === undefined) return cur ? (cur.data as T) : null;
    const w = await store.setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.modified) return next;
    await sleep(2 + Math.random() * 15 * (i + 1));
  }
  throw new Error("busy");
}

// work that may finish after the answer has gone out (Netlify keeps the function alive for it); awaited where there is no
// such hook (tests, older runtimes)
export async function later(context: Ctx, p: Promise<unknown>) {
  const q = p.catch(() => {});
  if (context && typeof context.waitUntil === "function") context.waitUntil(q); else await q;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export function safeEqual(a: unknown, b: unknown) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- who is asking: the client IP (an IPv6 /64 counts as one source), hashed so no raw address is stored
export function clientIp(req: Request, context?: Ctx) {
  let ip = String((context && context.ip) || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "").trim().toLowerCase();
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  if (ip.includes(":")) {
    const [head, tail] = ip.split("::"); const h = head ? head.split(":") : [], t = tail === undefined ? [] : tail ? tail.split(":") : [];
    const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
  }
  return ip;
}
export const ipKey = async (req: Request, context?: Ctx) => (await sha256("vijuga-ip:" + clientIp(req, context))).slice(0, 20);

// ---- the PIN failure limiter
// Each failed check is its own small blob (no two requests ever write the same key, so a burst of guesses is counted in
// full); a check lists the recent failures of this account and of this source. Only DIFFERENT wrong values count, so a
// device that keeps sending an old PIN after a change does not lock its owner out, but a guesser is stopped.
//   this source on this account: 5 different wrong PINs in 15 min
//   this source on any account:  30 in an hour (one address trying "1234" on every account)
//   this account from anywhere:  30 in an hour or 100 in a day (many addresses on one account)
// A locked check is refused (429) before the PIN is compared, so even the right PIN gets no answer while it lasts.
export const PIN_RULES = { ipSlug: [5, 15 * MIN], ip: [30, HOUR], slugHour: [30, HOUR], slugDay: [100, DAY] } as const;
const limits = () => getStore({ name: "vijuga-limits", consistency: "strong" });
type Fail = { t: number; who: string; h: string; key: string };
async function fails(prefix: string): Promise<Fail[]> {
  const { blobs } = await limits().list({ prefix });
  return blobs.map((b) => { const [t, who, h] = b.key.slice(prefix.length).split("."); return { t: parseInt(t, 36) || 0, who: who || "", h: h || "", key: b.key }; });
}
const distinct = (xs: Fail[], since: number, by: (f: Fail) => string) => { const s = new Map<string, number>(); for (const f of xs) if (f.t > since) { const k = by(f); s.set(k, Math.min(s.get(k) ?? Infinity, f.t)); } return [...s.values()].sort((a, b) => a - b); };
// seconds until the oldest failure that keeps the count at the cap leaves its window (0 = not locked)
function over(times: number[], cap: number, win: number, now: number) { return times.length >= cap ? Math.max(1, Math.ceil((times[times.length - cap] + win - now) / 1000)) : 0; }
function lockedFor(bySlug: Fail[], byIp: Fail[], ipk: string, now: number) {
  const R = PIN_RULES;
  return Math.max(
    over(distinct(bySlug.filter((f) => f.who === ipk), now - R.ipSlug[1], (f) => f.h), R.ipSlug[0], R.ipSlug[1], now),
    over(distinct(byIp, now - R.ip[1], (f) => f.who + "|" + f.h), R.ip[0], R.ip[1], now),
    over(distinct(bySlug, now - R.slugHour[1], (f) => f.h), R.slugHour[0], R.slugHour[1], now),
    over(distinct(bySlug, now - R.slugDay[1], (f) => f.h), R.slugDay[0], R.slugDay[1], now),
  );
}
export type Gate = { ok: true } | { ok: false; status: number; error: string; wait?: number };
// slug "_admin" is the maintenance key: counted per source only (nobody can lock the maintainer out from elsewhere)
export async function pinGate(req: Request, context: Ctx, slug: string, stored: unknown, given: unknown, opts: { requirePin?: boolean } = {}): Promise<Gate> {
  if (!stored) return opts.requirePin ? { ok: false, status: 403, error: "pin needed" } : { ok: true };
  const ipk = await ipKey(req, context), now = Date.now(), perSlug = slug !== "_admin";
  const [bySlug, byIp] = await Promise.all([fails(`pin/${slug}/`), fails(`pip/${ipk}/`)]);
  const scoped = perSlug ? bySlug : bySlug.filter((f) => f.who === ipk);
  const wait = lockedFor(scoped, byIp, ipk, now);
  if (wait) return { ok: false, status: 429, error: "too many attempts", wait };
  if (safeEqual(given, stored)) return { ok: true };
  const tag = (await sha256("fail:" + String(given ?? ""))).slice(0, 12), t36 = now.toString(36);
  const s = limits();
  await Promise.all([s.set(`pin/${slug}/${t36}.${ipk}.${tag}`, "1"), s.set(`pip/${ipk}/${t36}.${slug}.${tag}`, "1")]);
  // failures older than their longest window are dropped as they are seen (on the failure path only)
  const old = [...bySlug.filter((f) => f.t < now - DAY), ...byIp.filter((f) => f.t < now - HOUR)].slice(0, 40);
  await Promise.all(old.map((f) => s.delete(f.key)));
  return { ok: false, status: 403, error: "wrong pin" };
}
export async function account(slug: string) {
  if (!SLUG.test(slug)) return null;
  return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null;
}
// the account behind a request, PIN checked through the limiter
export async function authed(req: Request, context: Ctx, slug: string, auth: unknown, opts: { requirePin?: boolean } = {}): Promise<{ acc: Record<string, unknown> | null; gate: Gate }> {
  const acc = await account(slug);
  if (!acc) return { acc: null, gate: { ok: false, status: 403, error: "auth" } };
  return { acc, gate: await pinGate(req, context, slug, acc.pinHash, auth, opts) };
}

// ---- a plain sliding-window rate limit: rules [[count, windowMs], ...]; each allowed hit leaves one small blob
export async function hit(bucket: string, rules: [number, number][]): Promise<{ ok: boolean; wait: number }> {
  const s = limits(), now = Date.now(), prefix = `rate/${bucket}/`, longest = Math.max(...rules.map((r) => r[1]));
  const { blobs } = await s.list({ prefix });
  const times = blobs.map((b) => ({ key: b.key, t: parseInt(b.key.slice(prefix.length).split(".")[0], 36) || 0 }));
  const live = times.filter((x) => x.t > now - longest).map((x) => x.t).sort((a, b) => a - b);
  let wait = 0;
  for (const [n, win] of rules) wait = Math.max(wait, over(live.filter((t) => t > now - win), n, win, now));
  await Promise.all(times.filter((x) => x.t <= now - longest).slice(0, 40).map((x) => s.delete(x.key)));
  if (wait) return { ok: false, wait };
  await s.set(`${prefix}${now.toString(36)}.${Math.random().toString(36).slice(2, 8)}`, "1");
  return { ok: true, wait: 0 };
}

// ---- digests: one blob that mirrors a whole collection
// put() updates one entry (compare-and-swap) after the collection itself was written; if that ever fails, or the digest
// does not exist yet, a "dirty" mark makes the next read() rebuild it from the collection (the old, slow way), so the
// digest can lag but never stay wrong. Every put is stamped (`at`, or `gone` for a removal); a rebuild that started at
// `built` keeps whatever was put after it started, so it never undoes a newer change and never has to start over.
type Digest<V> = { built: number; items: Record<string, V>; at?: Record<string, number>; gone?: Record<string, number> };
const digests = () => getStore({ name: "vijuga-digests", consistency: "strong" });
const STAMPS_MS = 10 * MIN; // a rebuild takes seconds; older stamps are not needed
// keep(old, new): true when the entry already there is newer than the one being put (updates can arrive out of order)
export function digest<V>(name: string, rebuild: () => Promise<Record<string, V>>, keep?: (old: V, nu: V) => boolean) {
  const dirty = () => digests().setJSON(name + ".dirty", { at: Date.now() });
  const prune = (m: Record<string, number>, now: number) => { for (const k in m) if (m[k] < now - STAMPS_MS) delete m[k]; return m; };
  return {
    async put(key: string, value: V | null) {
      let missing = false;
      try {
        await cas<Digest<V>>(digests(), name, (cur) => {
          missing = !cur; if (!cur) return undefined;
          const now = Date.now(), at = prune(cur.at || {}, now), gone = prune(cur.gone || {}, now);
          if (value === null) { delete cur.items[key]; delete at[key]; gone[key] = now; }
          else if (keep && cur.items[key] && keep(cur.items[key], value)) return undefined;
          else { cur.items[key] = value; at[key] = now; delete gone[key]; }
          cur.at = at; cur.gone = gone;
          return cur;
        });
      } catch (e) { missing = true; }
      if (missing) await dirty().catch(() => {});
    },
    async read(): Promise<Record<string, V>> {
      const s = digests();
      const [cur, mark] = await Promise.all([s.getWithMetadata(name, { type: "json" }), s.get(name + ".dirty", { type: "json" }) as Promise<{ at: number } | null>]);
      const d = cur ? (cur.data as Digest<V>) : null;
      if (d && d.items && !(mark && mark.at >= d.built)) return d.items;
      const built = Date.now(), fresh = await rebuild();
      let items = fresh;
      await cas<Digest<V>>(s, name, (c) => {
        items = { ...fresh }; const at: Record<string, number> = {}, gone: Record<string, number> = {};
        for (const [k, t] of Object.entries(c?.at || {})) if (t >= built && c!.items[k] !== undefined) { items[k] = c!.items[k]; at[k] = t; }
        for (const [k, t] of Object.entries(c?.gone || {})) if (t >= built) { delete items[k]; gone[k] = t; }
        return { built, items, at, gone };
      }).catch(() => null);
      return items;
    },
  };
}

// ---- public profiles: what anybody may see of an account (no PIN hash, no private room code)
export function publicView(d: Record<string, unknown>) {
  const { pinHash, room, ...rest } = d;
  return { ...rest, hasPin: !!pinHash };
}
export const accountsIndex = digest<Record<string, unknown>>("accounts", async () => {
  const store = getStore({ name: "vijuga-accounts", consistency: "strong" });
  const { blobs } = await store.list();
  const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Record<string, unknown> | null>));
  return Object.fromEntries(docs.filter((d): d is Record<string, unknown> => !!d && typeof d.slug === "string").map((d) => [d.slug as string, publicView(d)]));
}, (old, nu) => Number(old.updatedAt) > Number(nu.updatedAt));
