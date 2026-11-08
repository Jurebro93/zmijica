// Gifts between Vijuga players. The giver pays in their own profile; the gift waits here until
// the receiver's game picks it up.
// POST   /api/gifts            {to, from, item, auth}  -> stores a pending gift (giver's PIN checked)
// GET    /api/gifts/:slug                              -> pending gifts for that player
// DELETE /api/gifts/:slug/:id  {auth}                  -> receiver marks one as collected
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const ITEM = /^[a-zA-Z0-9_]{2,20}$/;

async function account(slug: string) {
  return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const store = getStore({ name: "vijuga-gifts", consistency: "strong" });
  const slug = context.params.slug;
  if (req.method === "POST" && !slug) {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const to = String(b?.to ?? ""), from = String(b?.from ?? ""), item = String(b?.item ?? "");
    if (!SLUG.test(to) || !SLUG.test(from) || !ITEM.test(item) || to === from) return json({ error: "bad request" }, 400);
    const [giver, receiver] = await Promise.all([account(from), account(to)]);
    if (!giver || !receiver) return json({ error: "unknown player" }, 404);
    if (giver.pinHash && giver.pinHash !== b?.auth) return json({ error: "wrong pin" }, 403);
    const { blobs } = await store.list({ prefix: to + "/" });
    if (blobs.length >= 30) return json({ error: "too many pending gifts" }, 429);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await store.setJSON(`${to}/${id}`, { id, from, fromName: String(giver.name ?? from).slice(0, 14), item, at: Date.now() });
    return json({ ok: true, id });
  }
  if (!slug || !SLUG.test(slug)) return json({ error: "bad slug" }, 400);
  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: slug + "/" });
    const gifts = ((await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" })))) as unknown[]).filter(Boolean);
    return json({ gifts });
  }
  if (req.method === "DELETE") {
    const id = context.params.id;
    if (!id || !/^[a-z0-9]{4,20}$/.test(id)) return json({ error: "bad id" }, 400);
    const acc = await account(slug);
    const b = (await req.json().catch(() => ({}))) as { auth?: string };
    if (acc && acc.pinHash && acc.pinHash !== b.auth) return json({ error: "wrong pin" }, 403);
    await store.delete(`${slug}/${id}`);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: ["/api/gifts", "/api/gifts/:slug", "/api/gifts/:slug/:id"] };
