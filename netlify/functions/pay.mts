// Real-money entry to a tournament through Stripe Checkout (cards, Google Pay and Apple Pay show up there by themselves
// when they are switched on in the Stripe dashboard).
// POST /api/pay/checkout {slug, auth, tour, amount?} -> {url}  the player is sent to Stripe's payment page (amount: the
//                                               stake the player chose, for a tournament with a free stake)
// POST /api/pay/webhook  (Stripe)            -> a paid entry puts the player on the tournament; a late or extra payment
//                                               (tournament full, closed, already entered) is refunded at once
// GET  /api/pay/status                       -> {on}  whether payments are configured
// The webhook changes the tournament through tournament.mts's updateTour (the one compare-and-swap every change uses).
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { stripe, stripeOn, stripeTest, refund, verifySignature, webhookSecret } from "./stripe.mts";
import { updateTour, type Tour } from "./tournament.mts";
import { authed } from "./guard.mts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const SLUG = /^[a-z0-9-]{1,40}$/, TOUR_ID = /^[a-z0-9]{4,20}$/;
const GAME = "https://zmijica.onrender.com/";

// what a tournament accepts as one entry, in cents
const stakeOk = (t: Tour, cents: number) => t.eur ? cents === t.eur * 100 : !!t.stake && cents % 100 === 0 && cents >= t.stake.min * 100 && cents <= t.stake.max * 100;

const tours = () => getStore({ name: "vijuga-tournaments", consistency: "strong" });
async function account(slug: string) { return (await getStore({ name: "vijuga-accounts", consistency: "strong" }).get(slug, { type: "json" })) as Record<string, unknown> | null; }

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
    const prev = t.paid[slug];
    if (prev && prev.session === sid) { outcome = "duplicate"; return false; }
    // an earlier payment of this player that is not fully back on the card yet is never overwritten: the new one goes back
    const ok = (!!t.eur || !!t.stake) && t.status === "open" && t.players.length < t.max && !t.players.some((p) => p.slug === slug) && !!acc && stakeOk(t, cents) && !(prev && !prev.refunded);
    if (!ok) { outcome = "refund"; return false; }
    t.players.push({ slug, name: String(acc!.name ?? slug).slice(0, 14) });
    t.paid[slug] = { eur: cents / 100, pi, session: sid, at: Date.now() };
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
    const { acc, gate } = await authed(req, context, slug, b.auth), demo = stripeTest();
    if (!acc || !gate.ok) return !gate.ok && gate.status === 429 ? json({ error: gate.error, wait: gate.wait }, 429) : json({ error: "auth" }, 403);
    if (!acc.pinHash && !demo) return json({ error: "pin needed" }, 403); // real money: only an account with a PIN (demo money: anyone)
    const t = (await tours().get(id, { type: "json" })) as Tour | null; if (!t || (!t.eur && !t.stake)) return json({ error: "not found" }, 404);
    const euros = t.eur || Math.floor(Number(b.amount)); if (!stakeOk(t, euros * 100)) return json({ error: "bad amount", min: t.stake?.min, max: t.stake?.max }, 400);
    if (t.status !== "open") return json({ error: "registration closed" }, 409);
    if (t.players.some((p) => p.slug === slug)) return json({ error: "already in" }, 409);
    if (t.players.length >= t.max) return json({ error: "full" }, 409);
    const s = await stripe("checkout/sessions", {
      mode: "payment", locale: "hr", client_reference_id: slug,
      line_items: { 0: { quantity: 1, price_data: { currency: "eur", unit_amount: euros * 100, product_data: { name: `${t.stake ? "Ulog" : "Kotizacija"}: ${t.name}`.slice(0, 120), description: t.stake ? "Vijuga turnir. Fond se dijeli po ulogu: od svakog igrača možeš osvojiti najviše onoliko koliko si uložio." : "Vijuga turnir. Prva tri mjesta dijele nagradni fond (50 % / 30 % / 20 %)." } } } },
      // demo money (a sandbox key): the test card is written above the pay button, so a player only has to copy it
      ...(demo ? { custom_text: { submit: { message: "🧪 DEMO NOVAC, ništa se stvarno ne naplaćuje. Kartica: 4242 4242 4242 4242 · Datum: 12/34 · CVC: 123 · Ime i email: bilo što." } } } : {}),
      metadata: { tour: id, slug }, payment_intent_data: { metadata: { tour: id, slug }, description: `Vijuga turnir ${t.name} (${slug})`.slice(0, 200) },
      success_url: `${GAME}?placeno=${id}`, cancel_url: `${GAME}?placeno=odustao`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
    return json({ url: s.url });
  }
  return json({ error: "unknown action" }, 404);
};

export const config: Config = { path: ["/api/pay/:action"] };
