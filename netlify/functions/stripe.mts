// Minimal Stripe client for the real-money tournaments (no SDK: the REST API takes form-encoded bodies).
// Needs two environment variables on Netlify: STRIPE_SECRET_KEY (sk_live_… or sk_test_…) and STRIPE_WEBHOOK_SECRET (whsec_…).
const key = () => process.env.STRIPE_SECRET_KEY || "";
export const stripeOn = () => /^(sk|rk)_(live|test)_/.test(key());
export const stripeTest = () => /^(sk|rk)_test_/.test(key()); // a sandbox key: demo money, nothing is really charged
export const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET || "";

// {a: {b: 1}, c: [x]} -> a[b]=1&c[0]=x
function form(obj: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, name, out);
    else out.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(v)));
  }
  return out;
}

// a function runs for about 10 s at most, so Stripe gets 8 s by default (a timeout is an error: the caller retries later)
export async function stripe(path: string, params: Record<string, unknown> = {}, idempotencyKey?: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { authorization: "Bearer " + key(), "content-type": "application/x-www-form-urlencoded" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey; // the same refund asked twice is made only once
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers, body: form(params).join("&"), signal: ac.signal });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(String((j.error as Record<string, unknown> | undefined)?.message || "stripe " + r.status));
    return j;
  } finally { clearTimeout(timer); }
}

// a refund of one payment (all of it, or `cents` of it); safe to call more than once for the same payment and amount
export async function refund(paymentIntent: string, why: string, cents?: number, timeoutMs?: number) {
  const p: Record<string, unknown> = { payment_intent: paymentIntent, metadata: { why: why.slice(0, 200) } }; if (cents) p.amount = cents;
  return stripe("refunds", p, (cents ? `refund-${cents}-` : "refund-") + paymentIntent, timeoutMs);
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">  (several v1 values are possible while a secret is rotated)
export async function verifySignature(raw: string, header: string | null, secret: string, toleranceS = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((s) => s.trim().split("="));
  const t = Number(parts.find((p) => p[0] === "t")?.[1]); const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === mac.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}
