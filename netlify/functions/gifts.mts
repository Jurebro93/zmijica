// Gifts between Vijuga players. The giver pays in their own profile; the gift waits here until
// the receiver's game picks it up.
// POST   /api/gifts            {to, from, item, auth}  -> stores a pending gift (giver's PIN checked)
// GET    /api/gifts/:slug                              -> pending gifts for that player
// DELETE /api/gifts/:slug/:id  {auth}                  -> receiver collects one: 200 {ok} exactly once per gift;
//                                                         404 {error: "gone"} when it does not exist or was collected
// PIN checks go through the shared failure limiter (429 {error: "too many attempts", wait} while locked). A gift that does
// not exist answers "gone" before any PIN is looked at, so a made-up gift id tells nothing about a PIN.
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { account, pinGate } from "./guard.mts";
import { applyGift, bump, isThing, priceOf } from "./wallet.mts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/;
const ITEM = /^[a-zA-Z0-9_]{2,20}$/;

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
    const g = await pinGate(req, context, from, giver.pinHash, b?.auth);
    if (!g.ok) return g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error: "wrong pin" }, 403);
    const { blobs } = await store.list({ prefix: to + "/" });
    if (blobs.length >= 30) return json({ error: "too many pending gifts" }, 429);
    // a player gives a thing from the shop and pays its price here (not in the game's own copy of the profile)
    const price = priceOf(item); if (!isThing(item) || !price) return json({ error: "bad item" }, 400);
    const paid = await bump(from, (d) => { if ((Number(d.coins) || 0) < price) return false; d.coins -= price; d.spent = (Number(d.spent) || 0) + price; d.purchases = (Number(d.purchases) || 0) + 1; });
    if (!paid) return json({ error: "not enough coins" }, 409);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { await store.setJSON(`${to}/${id}`, { id, from, fromName: String(giver.name ?? from).slice(0, 14), item, at: Date.now() }); }
    catch (e) { await bump(from, (d) => { d.coins += price; d.spent = Math.max(0, (Number(d.spent) || 0) - price); }); return json({ error: "busy" }, 503); }
    return json({ ok: true, id, charged: price, rev: paid.updatedAt, prev: paid._prev });
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
    const gone = () => json({ error: "gone" }, 404);
    // no such gift: the same answer whoever asks and with whatever PIN
    const gift = (await store.get(`${slug}/${id}`, { type: "json" })) as { item?: string } | null; if (!gift) return gone();
    const acc = await account(slug); if (!acc) return gone();
    const b = (await req.json().catch(() => ({}))) as { auth?: string };
    const g = await pinGate(req, context, slug, acc.pinHash, b.auth);
    if (!g.ok) return g.status === 429 ? json({ error: g.error, wait: g.wait }, 429) : json({ error: "wrong pin" }, 403);
    // two tabs collecting the same gift at once: only the one that writes the claim first gets it
    const claim = await getStore({ name: "vijuga-gift-claims", consistency: "strong" }).setJSON(`${slug}/${id}`, { at: Date.now() }, { onlyIfNew: true });
    await store.delete(`${slug}/${id}`); // (also tidies up a gift whose claim was written by a request that died before this)
    if (!claim.modified) return gone();
    // credited here, on the server's copy of the account; the game shows the same and moves its base along
    let credit: Record<string, unknown> = {};
    const acc2 = await bump(slug, (d) => { credit = applyGift(d, String(gift.item || "")); });
    return json({ ok: true, credit, rev: acc2 ? acc2.updatedAt : null, prev: acc2 ? acc2._prev : null });
  }
  return json({ error: "method not allowed" }, 405);
};

export const config: Config = { path: ["/api/gifts", "/api/gifts/:slug", "/api/gifts/:slug/:id"] };
