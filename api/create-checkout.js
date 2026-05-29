// create-checkout.js -- Vercel serverless function that creates a Stripe
// Checkout Session combining the one-time launch fee + the monthly hosting
// subscription (with a 30-day trial). Single hosted URL the customer pays
// from -- no more "pay $250, wait, then manually send the $25/mo link."
//
// Written as plain .js (not .ts) to bypass Vercel's TypeScript bundler,
// which was generating an ES-module-flavored output that Node's runtime
// couldn't load. Same fix that was applied to send-email.js and state.js.
//
// How the combination works:
//   - Subscription mode lets us include BOTH one-time AND recurring line items.
//   - The one-time item ($250 or $500) is charged at session completion.
//   - The recurring item ($25 or $50 monthly) is wrapped in a 30-day trial,
//     so the first $25 charge hits ~30 days after they pay the setup fee.
//
// Required env vars (already set if /api/send-email works):
//   - STRIPE_SECRET_KEY  (rk_live_... restricted to Checkout + Subscriptions)
//   - SEND_EMAIL_KEY     (shared secret -- dashboard authorizes itself with this)
//
// Request:
//   POST /api/create-checkout
//   Header: X-Send-Key: <SEND_EMAIL_KEY value>
//   Body: {
//     "businessName": "Doug's Barber Shop",
//     "tier": "landing" | "store",          // default: "landing"
//     "customerEmail": "owner@dougs.com"     // optional, prefills checkout
//   }
//
// Response:
//   200 { ok: true, url: "https://checkout.stripe.com/c/pay/cs_...", sessionId: "cs_..." }
//   401 { ok: false, error: "Unauthorized" }
//   400 { ok: false, error: "Missing field: ..." }
//   500 { ok: false, error: "..." }

const Stripe = require("stripe");

// Tier-specific pricing. Editable here, no Stripe Product setup needed --
// these get created on the fly via price_data on each checkout session.
// Internal keys "landing" / "store" are kept for API contract stability;
// customer-facing labels use the simpler Tier 1 / Tier 2 terminology.
const TIERS = {
  landing: {
    launchAmountCents: 25000,
    launchLabel: "Tier 1 Launch (one-time setup)",
    hostingAmountCents: 2500,
    hostingLabel: "Tier 1 Hosting (monthly)",
  },
  store: {
    launchAmountCents: 50000,
    launchLabel: "Tier 2 Launch (one-time setup)",
    hostingAmountCents: 5000,
    hostingLabel: "Tier 2 Hosting (monthly)",
  },
};

const DASHBOARD_URL = "https://dashboard-deploy-eight-kappa.vercel.app/?key=jb2026";

module.exports = async function handler(req, res) {
  // CORS preflight -- dashboard calls this from the browser.
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Send-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  // Shared-secret auth -- same key as /api/send-email so the dashboard only
  // needs to prompt once. If you ever need a separate key, split this.
  const sentKey = req.headers["x-send-key"];
  const expectedKey = process.env.SEND_EMAIL_KEY;
  if (!expectedKey) {
    console.error("SEND_EMAIL_KEY env var is not set");
    res.status(500).json({ ok: false, error: "Server misconfigured" });
    return;
  }
  if (sentKey !== expectedKey) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const body = req.body || {};
  if (!body.businessName || typeof body.businessName !== "string") {
    res.status(400).json({ ok: false, error: "Missing field: businessName" });
    return;
  }
  const tier = body.tier === "store" ? "store" : "landing";
  const pricing = TIERS[tier];

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("STRIPE_SECRET_KEY env var is not set");
    res.status(500).json({ ok: false, error: "Stripe not configured" });
    return;
  }
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-04-10" });

  try {
    // Sanitize businessName for metadata (Stripe caps values at 500 chars).
    const safeName = body.businessName.slice(0, 200);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      // Prefill customer email so they don't have to type it.
      customer_email: body.customerEmail || undefined,
      // Mixed line items in subscription mode:
      //   - The one-time launch fee is charged at session completion.
      //   - The recurring hosting is wrapped in a 30-day trial, so first
      //     monthly charge hits ~30 days after the setup payment.
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: pricing.launchLabel + " -- " + safeName },
            unit_amount: pricing.launchAmountCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "usd",
            product_data: { name: pricing.hostingLabel + " -- " + safeName },
            unit_amount: pricing.hostingAmountCents,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 30,
        // Metadata flows through to invoice.paid events so the webhook
        // knows which business this renewal is for.
        metadata: {
          businessName: safeName,
          tier: tier,
        },
      },
      // Session-level metadata is on the checkout.session.completed event.
      metadata: {
        businessName: safeName,
        tier: tier,
        combinedCheckout: "true",
      },
      success_url: DASHBOARD_URL + "&paid=" + encodeURIComponent(safeName),
      cancel_url: DASHBOARD_URL,
      // 24 hours -- if they bail on the link and come back tomorrow, expire it
      // so the dashboard doesn't think they're still "live in checkout."
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });

    console.log("Created checkout session:", {
      businessName: safeName,
      tier: tier,
      sessionId: session.id,
    });

    res.status(200).json({
      ok: true,
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : "unknown";
    console.error("Checkout creation failed:", msg);
    const shortMsg = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
    res.status(500).json({ ok: false, error: shortMsg });
  }
};
