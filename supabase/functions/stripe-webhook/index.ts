// Tape: Stripe webhook -> tape_access.
// Stripe calls this after a payment, a renewal or a cancellation and the customer's plan is switched on or off by itself.
// Secrets live only in Supabase (Edge Functions -> Secrets), never in this repository:
//   STRIPE_SECRET_KEY        sk_live_... (or sk_test_... while testing)
//   STRIPE_WEBHOOK_SECRET    whsec_...   (from the webhook endpoint in Stripe)
//   PRICE_PRO, PRICE_PRO_YEAR, PRICE_SMART, PRICE_SMART_YEAR   price_... ids of the four prices
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions by Supabase itself.
// Deploy with JWT verification OFF (Stripe does not send a Supabase token); the Stripe signature is checked below instead.

const env = (k: string) => Deno.env.get(k) ?? "";
const SB = env("SUPABASE_URL"), SRK = env("SUPABASE_SERVICE_ROLE_KEY"), SK = env("STRIPE_SECRET_KEY"), WH = env("STRIPE_WEBHOOK_SECRET");
const PLAN_OF: Record<string, string> = {};
for (const [k, p] of [["PRICE_PRO", "pro"], ["PRICE_PRO_YEAR", "pro"], ["PRICE_SMART", "smart"], ["PRICE_SMART_YEAR", "smart"]]) { const id = env(k); if (id) PLAN_OF[id] = p; }
const GRACE = 2 * 86400; // two days on top of the paid period, so a renewal a few hours late does not lock anyone out
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function verify(body: string, header: string | null) {
  if (!header || !WH) return false;
  const parts = Object.fromEntries(header.split(",").map((x) => x.split("=", 2) as [string, string]).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts["t"]); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = await hmacHex(WH, `${t}.${body}`);
  return header.split(",").filter((x) => x.startsWith("v1=")).some((x) => safeEq(x.slice(3), want));
}
async function stripe(path: string) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: "Bearer " + SK } });
  if (!r.ok) throw new Error("stripe " + path + " " + r.status);
  return await r.json();
}
async function db(method: string, query: string, body?: unknown, prefer = "") {
  const r = await fetch(`${SB}/rest/v1/tape_access${query}`, { method, headers: { apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error("db " + r.status + " " + (await r.text()));
  return r.status === 204 ? null : await r.json().catch(() => null);
}
// newer Stripe API versions keep the period end on the subscription item, older ones on the subscription
function periodOf(sub: any) { const it = sub?.items?.data?.[0]; return { price: it?.price?.id ?? "", end: Number(it?.current_period_end ?? sub?.current_period_end ?? 0) }; }
const iso = (sec: number) => new Date((sec + GRACE) * 1000).toISOString();
const live = (s: string) => ["active", "trialing", "past_due"].includes(s);

async function fromSubscription(subId: string, uid?: string) {
  const sub = await stripe("subscriptions/" + encodeURIComponent(subId)), p = periodOf(sub), plan = PLAN_OF[p.price];
  if (!plan) { console.log("unknown price", p.price); return; }
  const row: Record<string, unknown> = { plan, source: "stripe", stripe_customer: sub.customer, stripe_sub: sub.id, updated_at: new Date().toISOString(), valid_until: live(sub.status) && p.end ? iso(p.end) : new Date().toISOString() };
  if (uid) { row.user_id = uid; await db("POST", "?on_conflict=user_id", row, "resolution=merge-duplicates,return=minimal"); }
  else await db("PATCH", "?stripe_sub=eq." + encodeURIComponent(sub.id), row, "return=minimal");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await verify(body, req.headers.get("stripe-signature")))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(body), o = ev?.data?.object ?? {};
  try {
    if (ev.type === "checkout.session.completed") {
      const uid = String(o.client_reference_id ?? ""); if (!UUID.test(uid)) { console.log("session without a Tape user id", o.id); return new Response("ok"); }
      if (o.subscription) await fromSubscription(String(o.subscription), uid);
    } else if (ev.type === "invoice.paid") {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription; if (subId) await fromSubscription(String(subId));
    } else if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
      await fromSubscription(String(o.id));
    }
  } catch (e) { console.error(e); return new Response("retry later", { status: 500 }); } // Stripe retries on 5xx
  return new Response("ok");
});
