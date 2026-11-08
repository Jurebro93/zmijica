// "When do we meet?" poll for Vijuga: each player marks the hours they are free today/tomorrow.
// GET  /api/meet?days=2026-11-08,2026-11-09 -> { votes: { [day]: [{slug, name, color, slots, at}] } }
// POST /api/meet {slug, day, slots:[hours], auth} -> stores that player's slots for the day (auth = profile PIN hash)
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// only days close to now are accepted (covers every time zone)
const nearDay = (d: string) => { const t = Date.parse(d + "T12:00:00Z"); return Number.isFinite(t) && Math.abs(t - Date.now()) < 3 * 86400000; };

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: "vijuga-meet", consistency: "strong" });
  if (req.method === "GET") {
    const days = (new URL(req.url).searchParams.get("days") || "").split(",").filter((d) => DAY.test(d) && nearDay(d)).slice(0, 3);
    const votes: Record<string, unknown[]> = {};
    for (const day of days) {
      const { blobs } = await store.list({ prefix: day + "/" });
      votes[day] = ((await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))) as unknown[]).filter(Boolean);
    }
    return json({ votes });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "body missing" }, 400);
  const slug = String(b.slug ?? ""), day = String(b.day ?? "");
  if (!SLUG.test(slug) || !DAY.test(day) || !nearDay(day)) return json({ error: "bad slug or day" }, 400);
  const acc = (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null;
  if (!acc) return json({ error: "unknown player" }, 404);
  if (acc.pinHash && acc.pinHash !== b.auth) return json({ error: "wrong pin" }, 403);
  const slots = Array.isArray(b.slots) ? [...new Set(b.slots.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((x, y) => x - y) : [];
  const key = `${day}/${slug}`;
  if (!slots.length) { await store.delete(key); return json({ ok: true, removed: true }); }
  await store.setJSON(key, { slug, name: String(acc.name ?? slug).slice(0, 14), color: Number(acc.color) || 0, slots, at: Date.now() });
  return json({ ok: true });
};

export const config: Config = { path: "/api/meet" };
