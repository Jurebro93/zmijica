// Real-money entry to a tournament through Stripe Checkout (cards, Google Pay and Apple Pay show up there by themselves
// when they are switched on in the Stripe dashboard).
// POST /api/pay/checkout {slug, auth, tour}  -> {url}  the player is sent to Stripe's payment page
// POST /api/pay/webhook  (Stripe)            -> a paid entry puts the player on the tournament; a late or extra payment
//                                               (tournament full, closed, already entered) is refunded at once
// GET  /api/pay/status                       -> {on}  whether payments are configured
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { stripe, stripeOn, refund, verifySignature, webhookSecret } from "./stripe.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, TOUR_ID = /^[a-z0-9]{4,20}$/;
const GAME = "https://zmijica.onrender.com/";
export const EUR_LEVELS = [5, 10, 15];

type Paid = { eur: number; pi: string; session: string; at: number; refunded?: number };
type Tour = { id: string; name: string; status: string; max: number; eur?: number; players: { slug: string; name: string }[]; paid?: Record<string, Paid> };

const tours = () => getStore({ name: "vijuga-tournaments", consistency: "strong" });
async function account(slug: string) { return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null; }

// read-modify-write of one tournament that survives two writers at once (a webhook and a player's click)
async function updateTour(id: string, fn: (t: Tour) => void | Promise<void>) {
  const s = tours();
  for (let i = 0; i < 6; i++) {
    const cur = await s.getWithMetadata(id, { type: "json" }); if (!cur) return null;
    const t = cur.data as Tour; await fn(t);
    const w = await s.setJSON(id, t, { onlyIfMatch: cur.etag }); if (w.modified) return t;
  }
  throw new Error("busy");
}

async function onPaid(session: Record<string, unknown>) {
  const md = (session.metadata || {}) as Record<string, string>; const id = String(md.tour || ""), slug = String(md.slug || "");
  const pi = String(session.payment_intent || ""), sid = String(session.id || ""), cents = Number(session.amount_total) || 0;
  if (!TOUR_ID.test(id) || !SLUG.test(slug) || !pi) return "ignored";
  // every Stripe event can arrive more than once (and two copies at the same time): the session id makes it count once
  const pay = getStore({ name: "vijuga-pay", consistency: "strong" });
  if (await pay.get("session/" + sid)) return "duplicate";
  let outcome = "joined";
  const acc = await account(slug);
  const t = await updateTour(id, (t) => {
    t.paid = t.paid || {}; outcome = "joined";
    if (t.paid[slug] && t.paid[slug].session === sid) { outcome = "duplicate"; return; }
    const ok = !!t.eur && t.status === "open" && t.players.length < t.max && !t.players.some((p) => p.slug === slug) && !!acc && cents === t.eur * 100;
    if (!ok) { outcome = "refund"; return; }
    t.players.push({ slug, name: String(acc!.name ?? slug).slice(0, 14) });
    t.paid[slug] = { eur: t.eur!, pi, session: sid, at: Date.now() };
  });
  if (!t || outcome === "refund") { await refund(pi, "Vijuga: turnir zatvoren, pun ili već prijavljen"); outcome = "refunded"; }
  await pay.setJSON("session/" + sid, { id, slug, pi, cents, outcome, at: Date.now() });
  return outcome;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const action = context.params.action;
  if (action === "status") return json({ on: stripeOn() });

  if (action === "webhook" && req.method === "POST") {
    const raw = await req.text();
    if (!(await verifySignature(raw, req.headers.get("stripe-signature"), webhookSecret()))) return json({ error: "bad signature" }, 400);
    const ev = JSON.parse(raw) as { type?: string; data?: { object?: Record<string, unknown> } };
    const o = ev.data?.object || {};
    if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && o.payment_status === "paid") {
      try { return json({ received: true, result: await onPaid(o) }); } catch (e) { return json({ error: String(e) }, 500); } // a 500 makes Stripe send it again
    }
    return json({ received: true });
  }

  if (action === "checkout" && req.method === "POST") {
    if (!stripeOn()) return json({ error: "payments off" }, 503);
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null; if (!b) return json({ error: "body missing" }, 400);
    const slug = String(b.slug ?? ""), id = String(b.tour ?? "");
    if (!SLUG.test(slug) || !TOUR_ID.test(id)) return json({ error: "bad request" }, 400);
    const acc = await account(slug);
    if (!acc || !acc.pinHash || acc.pinHash !== b.auth) return json({ error: acc && !acc.pinHash ? "pin needed" : "auth" }, 403); // real money: only an account with a PIN
    const t = (await tours().get(id, { type: "json" })) as Tour | null; if (!t || !t.eur) return json({ error: "not found" }, 404);
    if (t.status !== "open") return json({ error: "registration closed" }, 409);
    if (t.players.some((p) => p.slug === slug)) return json({ error: "already in" }, 409);
    if (t.players.length >= t.max) return json({ error: "full" }, 409);
    const s = await stripe("checkout/sessions", {
      mode: "payment", locale: "hr", client_reference_id: slug,
      line_items: { 0: { quantity: 1, price_data: { currency: "eur", unit_amount: t.eur * 100, product_data: { name: `Kotizacija: ${t.name}`.slice(0, 120), description: "Vijuga turnir. Prva tri mjesta dijele nagradni fond (50 % / 30 % / 20 %)." } } } },
      metadata: { tour: id, slug }, payment_intent_data: { metadata: { tour: id, slug }, description: `Vijuga turnir ${t.name} (${slug})`.slice(0, 200) },
      success_url: `${GAME}?placeno=${id}`, cancel_url: `${GAME}?placeno=odustao`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
    return json({ url: s.url });
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/pay/:action"] };
