// Voice messages for Vijuga: a short clip is posted here once and every listener fetches it by its id, so the clip never
// travels the realtime connection a match runs on (a 100 kB message there held the match up for everybody).
// POST /api/voice {slug, auth, data}  data: the clip in base64 ("VJA1" IMA ADPCM, 16 kHz mono; at most 48 kB)  -> {id}
// GET  /api/voice?id=<id>             -> the clip (application/octet-stream), cacheable: an id never changes
// Clips are kept 20 minutes (older ones are deleted as new ones come in). A sender may post 4 clips in 20 s and 40 in
// 10 min (an address: 8 / 80); a muted player cannot post.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { loadRoles } from "./roles.mts";
import { account, hit, ipKey, pinGate } from "./guard.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, ID = /^[0-9]{13}-[a-z0-9]{8}$/, B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX = 48 * 1024, KEEP_MS = 20 * 60_000, S20 = 20_000, M10 = 10 * 60_000;
const clips = () => getStore({ name: "vijuga-voice", consistency: "strong" });

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = clips();
  if (req.method === "GET") {
    const id = String(new URL(req.url).searchParams.get("id") || "");
    if (!ID.test(id)) return json({ error: "bad id" }, 400);
    if (Date.now() - Number(id.slice(0, 13)) > KEEP_MS) return json({ error: "gone" }, 410);
    const data = await store.get(id, { type: "arrayBuffer" });
    if (!data) return json({ error: "not found" }, 404);
    return new Response(data, { status: 200, headers: { ...cors, "content-type": "application/octet-stream", "cache-control": "public, max-age=1200, immutable" } });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""), data = String(b.data ?? "");
  if (!SLUG.test(slug) || !data || data.length > Math.ceil(MAX / 3) * 4 || !B64.test(data)) return json({ error: "bad request" }, 400);
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  // only a clip of the game's own kind: "VJA1", a sane rate, as many samples as the bytes hold, at most ~6 s
  const dv = new DataView(bytes.buffer), rate = bytes.length >= 12 ? dv.getUint16(4, true) : 0, n = bytes.length >= 12 ? dv.getUint32(6, true) : 0;
  if (bytes.length < 12 || bytes[0] !== 86 || bytes[1] !== 74 || bytes[2] !== 65 || bytes[3] !== 49 || rate < 8000 || rate > 24000 || n < 1 || Math.ceil(n / 2) + 12 !== bytes.length || n > rate * 6.5) return json({ error: "bad clip" }, 400);
  const acc = await account(slug); if (!acc) return json({ error: "auth" }, 403);
  const g = await pinGate(req, context, slug, acc.pinHash, b.auth);
  if (!g.ok) return g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error: "auth" }, 403);
  const { mutes } = await loadRoles(); if ((mutes[slug] || 0) > Date.now()) return json({ error: "muted", until: mutes[slug] }, 403);
  const [bySender, byIp] = await Promise.all([hit("voice/" + slug, [[4, S20], [40, M10]]), hit("voiceip/" + (await ipKey(req, context)), [[8, S20], [80, M10]])]);
  if (!bySender.ok || !byIp.ok) return json({ error: "slow down", wait: Math.max(bySender.wait, byIp.wait) }, 429);
  const now = Date.now(), id = `${now}-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
  await store.set(id, bytes.buffer as ArrayBuffer);
  // the old ones go (ids start with the time, so a key tells its age)
  try { const { blobs } = await store.list(); await Promise.all(blobs.filter((x) => now - Number(x.key.slice(0, 13)) > KEEP_MS).slice(0, 50).map((x) => store.delete(x.key))); } catch (e) {}
  return json({ id });
};

export const config: Config = { path: "/api/voice" };
