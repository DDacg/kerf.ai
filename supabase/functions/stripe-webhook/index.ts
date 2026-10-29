// Stripe webhook for Kerf AI.
// Stripe calls this when someone pays. It adds credits and sets the plan on their profile.
// Needs one secret in Supabase (Edge Functions > Secrets): STRIPE_WEBHOOK_SECRET (the "whsec_..." signing secret).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// What each checkout buys, keyed by the price before tax and discounts (in cents).
const PLANS: Record<number, { plan: string; interval: "month" | "year"; credits: number }> = {
  1000: { plan: "starter", interval: "month", credits: 200 },
  9600: { plan: "starter", interval: "year", credits: 2400 },
  2000: { plan: "creator", interval: "month", credits: 500 },
  19200: { plan: "creator", interval: "year", credits: 6000 },
  4900: { plan: "studio", interval: "month", credits: 1500 },
  49000: { plan: "studio", interval: "year", credits: 18000 },
};
const PACKS: Record<number, number> = { 600: 100, 1500: 300, 4500: 1000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function verify(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"];
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && timingSafeEqual(s, hex));
}
function timingSafeEqual(a: string, b: string) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ error: "POST only" }, 405);
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return ok({ error: "STRIPE_WEBHOOK_SECRET is not set" }, 500);

  const payload = await req.text();
  if (!(await verify(payload, req.headers.get("stripe-signature"), secret))) return ok({ error: "bad signature" }, 400);

  const event = JSON.parse(payload);
  const { data: seen } = await db.from("stripe_events").select("id").eq("id", event.id).maybeSingle();
  if (seen) return ok({ received: true, duplicate: true });

  try {
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        if (!["paid", "no_payment_required"].includes(o.payment_status)) break;
        const user = o.client_reference_id;
        if (!user || !UUID.test(user)) {
          console.warn("checkout without a signed-in user", o.id);
          break;
        }
        const cents = Number(o.amount_subtotal ?? o.amount_total ?? 0);
        if (o.mode === "subscription") {
          const p = PLANS[cents];
          if (!p) { console.warn("unknown plan amount", cents, o.id); break; }
          const { error } = await db.rpc("apply_purchase", {
            p_user: user, p_credits: p.credits, p_plan: p.plan, p_interval: p.interval,
            p_customer: o.customer ?? null, p_subscription: o.subscription ?? null,
          });
          if (error) throw error;
        } else if (o.mode === "payment") {
          const credits = PACKS[cents];
          if (!credits) { console.warn("unknown pack amount", cents, o.id); break; }
          const { error } = await db.rpc("apply_purchase", { p_user: user, p_credits: credits, p_customer: o.customer ?? null });
          if (error) throw error;
        }
        break;
      }
      case "invoice.paid": {
        // The first invoice is handled by checkout above; refill on each renewal.
        if (o.billing_reason === "subscription_cycle" && o.customer) {
          const { error } = await db.rpc("refill_by_customer", { p_customer: o.customer });
          if (error) throw error;
        }
        break;
      }
      case "customer.subscription.deleted": {
        if (o.customer) {
          const { error } = await db.rpc("end_subscription", { p_customer: o.customer });
          if (error) throw error;
        }
        break;
      }
    }
    await db.from("stripe_events").insert({ id: event.id, type: event.type });
    return ok({ received: true });
  } catch (e) {
    console.error("webhook failed", event.type, event.id, e);
    return ok({ error: "processing failed" }, 500); // Stripe retries later
  }
});
