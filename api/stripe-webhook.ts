// stripe-webhook.ts -- Vercel serverless function that receives Stripe webhook
// events, verifies the signature, and pings ntfy.sh/johnathon-builds-2026 so
// Johnathon's phone buzzes the moment a client pays.
//
// Wiring:
//   Stripe -> POST https://<your-project>.vercel.app/api/stripe-webhook
//   This function -> POST https://ntfy.sh/johnathon-builds-2026
//
// Env vars required (set in Vercel project settings):
//   - STRIPE_WEBHOOK_SECRET  (from Stripe Dashboard > Developers > Webhooks > endpoint > Signing secret)
//   - STRIPE_SECRET_KEY      (from Stripe Dashboard > Developers > API keys, restricted to webhooks only is fine)
//   - NTFY_URL               (optional, defaults to ntfy.sh/johnathon-builds-2026)

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

// IMPORTANT: signature verification requires the RAW request body, not the
// parsed JSON. Tell Vercel to skip its body parser for this endpoint.
export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-04-10',
});

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh/johnathon-builds-2026';
const DASHBOARD_URL = 'https://johnathon-builds.vercel.app/dashboard.html';

// Map a Stripe amount + mode + metadata to the pricing tiers from CLAUDE.md.
// If the session metadata has combinedCheckout=true (from /api/create-checkout),
// we recognize the new combined flow which charges $250 today + signs up for
// the $25/mo with a 30-day trial. Otherwise we fall back to amount-based
// tier matching for the old separate Payment Links.
function tierFromAmount(
  amountCents: number,
  mode: string,
  metadata?: Record<string, string> | null
): string {
  // Combined checkout (new flow). The amount_total is the launch fee
  // because the recurring portion is in trial ($0 today).
  if (metadata && metadata.combinedCheckout === 'true') {
    const t = metadata.tier === 'store' ? 'store' : 'landing';
    if (t === 'store') return 'Tier 2 Combined ($500 + $50/mo after 30d trial)';
    return 'Tier 1 Combined ($250 + $25/mo after 30d trial)';
  }
  if (mode === 'subscription') {
    if (amountCents === 2500) return 'Tier 1 Hosting ($25/mo)';
    if (amountCents === 5000) return 'Tier 2 Hosting ($50/mo)';
    return `$${(amountCents / 100).toFixed(2)}/mo recurring`;
  }
  if (amountCents === 25000) return 'Tier 1 Launch ($250)';
  if (amountCents === 50000) return 'Tier 2 Launch ($500)';
  return `$${(amountCents / 100).toFixed(2)} one-time`;
}

// Read the raw body off the Node request stream.
async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

// Build the ntfy body for a NEW payment (first time -- one-time launch fee
// or first month of a subscription). Plain text only -- URLs go in the Actions
// header per the CLAUDE.md ntfy URL rule. Kept under ~200 chars for phone.
function buildNtfyBody(
  tier: string,
  customerName: string,
  customerEmail: string | undefined
): string {
  const who = customerName || customerEmail || 'anonymous';
  return `Stripe just paid: ${tier} from ${who}. Click Paid in the dashboard.`;
}

// Build the ntfy body for a RECURRING renewal payment (months 2+).
// Adds the "paid through" date so Johnathon knows when the next renewal hits.
function buildRenewalBody(
  tier: string,
  customerName: string,
  customerEmail: string | undefined,
  periodEndSeconds: number | null
): string {
  const who = customerName || customerEmail || 'customer';
  let nextStr = '';
  if (periodEndSeconds && periodEndSeconds > 0) {
    try {
      const d = new Date(periodEndSeconds * 1000);
      const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      nextStr = ` Paid through ${formatted}.`;
    } catch {}
  }
  return `Renewal: ${tier} from ${who}.${nextStr}`;
}

// Build the welcome email body for a customer who just paid. Tier-specific
// copy so they see something relevant to what they bought. Plain text.
function buildWelcomeEmail(tier: string, amountCents: number, mode: string): { subject: string; body: string } {
  const isStore = tier.toLowerCase().includes('store');
  const isCombined = tier.toLowerCase().includes('combined');
  const isLaunch = mode === 'payment';

  // Combined launch + subscription with 30-day trial. Customer paid the
  // setup fee today; their first recurring charge hits in 30 days.
  if (isCombined) {
    const product = isStore ? 'online store' : 'website';
    const launchAmt = isStore ? '$500' : '$250';
    const monthlyAmt = isStore ? '$50' : '$25';
    return {
      subject: `Payment received -- your ${product} is locked in`,
      body:
        `Hi,\n\n` +
        `Thanks for the payment -- I just got confirmation. You're officially on the books.\n\n` +
        `What you paid for today:\n\n` +
        `  - ${launchAmt} one-time setup fee -- I convert your demo to a fully live site (real hours, real photos, real prices, no placeholders).\n` +
        `  - ${monthlyAmt}/month hosting subscription -- starts in 30 days, billed automatically each month. Covers hosting, edits, and support.\n\n` +
        `What happens next:\n\n` +
        `  1. Within 24 hours I'll update your site with all the real info. The placeholder marks (asterisks next to prices, "REPLACE WITH REAL PHOTO" notes) will all be gone.\n\n` +
        `  2. You'll get an editor link from me so you can change any text or photo yourself, anytime, from your phone. Takes 30 seconds. Hit Save and the change is live in 15 seconds.\n\n` +
        `  3. Your first ${monthlyAmt}/month charge hits 30 days from today -- gives you a free month of hosting included with the setup. You can cancel anytime.\n\n` +
        `Reply with anything you want updated -- photos, hours, copy changes, whatever -- and I'll get it on the site today.\n\n` +
        `Thanks again,\n` +
        `Johnathon\n` +
        `Johnathon Builds`,
    };
  }

  if (isLaunch) {
    const product = isStore ? 'online store' : 'website';
    return {
      subject: `Payment received -- your ${product} is next`,
      body:
        `Hi,\n\n` +
        `Thanks for the payment -- I just got confirmation for ${tier}. You're officially on the books.\n\n` +
        `Here's what happens next:\n\n` +
        `  1. Within the next 24 hours I'll update your site with the real info -- your hours, real photos if you've sent them, your email for the contact form, and your real prices. The placeholder marks (asterisks next to prices, "REPLACE WITH REAL PHOTO" notes) will all be gone.\n\n` +
        `  2. You'll get an editor link from me so you can change any text or photo on your site yourself, anytime, from your phone. Takes 30 seconds. Hit Save and the change is live in 15 seconds.\n\n` +
        `  3. Your $${isStore ? '50' : '25'}/month hosting kicks in 30 days from today. I'll send the recurring payment link separately so you can set it up when ready.\n\n` +
        `If you want to send over photos, your real hours, or anything else now -- just reply to this email and I'll get them onto the site.\n\n` +
        `Thanks again,\n` +
        `Johnathon\n` +
        `Johnathon Builds`,
    };
  }

  // Subscription start (first month of hosting)
  return {
    subject: `Hosting subscription active -- you're all set`,
    body:
      `Hi,\n\n` +
      `Just confirming your ${tier} subscription is active. Your site stays live and I handle the hosting, edits, and support from here.\n\n` +
      `Need a change to the site? Reply to this email or text me anytime -- usually I can have it live in under an hour. You can also edit text and photos yourself through the editor link I sent earlier.\n\n` +
      `Thanks for keeping it going,\n` +
      `Johnathon`,
  };
}

// POST to /api/send-email with the customer's welcome. Never throws -- email
// failure must not cause Stripe to retry the webhook.
async function sendWelcomeEmail(
  to: string,
  tier: string,
  amountCents: number,
  mode: string
): Promise<void> {
  const sendKey = process.env.SEND_EMAIL_KEY;
  if (!sendKey) {
    console.log('SEND_EMAIL_KEY not set, skipping welcome email');
    return;
  }
  if (!to) {
    console.log('No customer email on payment, skipping welcome email');
    return;
  }

  const { subject, body } = buildWelcomeEmail(tier, amountCents, mode);
  // Use the same Vercel project's /api/send-email -- relative URL works because
  // both functions are deployed to the same project. Vercel exposes the
  // project's own URL via the VERCEL_URL env var (host only, no scheme).
  const host = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) {
    console.error('VERCEL_URL env var not available, cannot self-call /api/send-email');
    return;
  }
  const endpoint = `https://${host}/api/send-email`;

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Send-Key': sendKey,
      },
      body: JSON.stringify({ to, subject, body, fromName: 'Johnathon Builds' }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('send-email returned non-2xx:', r.status, text);
    } else {
      console.log('Welcome email sent to', to);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('send-email POST failed:', msg);
  }
}

// Fire the ntfy. Never throws -- a failed ntfy must not cause Stripe to retry
// (the money is already collected). Log to Vercel function logs instead.
async function sendNtfy(body: string, title: string = 'Money landed'): Promise<void> {
  try {
    const r = await fetch(NTFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': title,
        'Actions': `view, Open Dashboard, ${DASHBOARD_URL}`,
      },
      body,
    });
    if (!r.ok) {
      console.error('ntfy returned non-2xx:', r.status, await r.text().catch(() => ''));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('ntfy POST failed:', msg);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Stripe only sends POSTs. Reject everything else so misdirected GETs
  // (browsers, scanners) don't fill the logs with bogus warnings.
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).send('Missing Stripe-Signature header');
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET env var is not set');
    res.status(500).send('Server misconfigured');
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('Failed to read raw body:', msg);
    res.status(400).send('Failed to read request body');
    return;
  }

  // Verify the signature. If this throws, the request is either malformed or
  // not actually from Stripe -- drop it.
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('Stripe signature verification failed:', msg);
    res.status(400).send(`Webhook signature verification failed: ${msg}`);
    return;
  }

  // Branch by event type. We handle:
  //   - checkout.session.completed -- new payment (launch fee OR first month of sub)
  //   - invoice.paid              -- recurring renewal (months 2+ of a subscription)
  // Future events (refunded, disputed, subscription canceled) can be added as
  // additional branches.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const amountCents = session.amount_total ?? 0;
    const mode = session.mode ?? 'payment';
    const customerName = session.customer_details?.name ?? '';
    const customerEmail = session.customer_details?.email ?? undefined;
    // Metadata flows from /api/create-checkout. Includes combinedCheckout
    // and tier so we can distinguish the new combined flow from a plain
    // Payment Link checkout.
    const metadata = (session.metadata || {}) as Record<string, string>;

    const tier = tierFromAmount(amountCents, mode, metadata);
    const body = buildNtfyBody(tier, customerName, customerEmail);

    console.log('Stripe paid (checkout.session.completed):', {
      tier, customerName, customerEmail, mode, amountCents,
    });
    await sendNtfy(body, 'Money landed');

    // Auto-welcome email to the customer. Fire-and-forget -- failure logged
    // but never blocks the 200 response.
    if (customerEmail) {
      await sendWelcomeEmail(customerEmail, tier, amountCents, mode);
    }

    res.status(200).json({
      received: true,
      type: 'checkout.session.completed',
      tier,
      customer: customerName || customerEmail || null,
    });
    return;
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;

    // Skip the FIRST invoice of a new subscription -- that's already handled
    // by checkout.session.completed above, and we don't want to double-ntfy
    // on signup. billing_reason === 'subscription_create' marks the first one.
    if (invoice.billing_reason === 'subscription_create') {
      console.log('Skipping first-invoice (covered by checkout.session.completed):', invoice.id);
      res.status(200).json({ received: true, skipped: 'first-invoice' });
      return;
    }

    const amountCents = invoice.amount_paid ?? 0;
    const customerName = invoice.customer_name ?? '';
    const customerEmail = invoice.customer_email ?? undefined;
    const periodEnd = invoice.period_end ?? null;

    const tier = tierFromAmount(amountCents, 'subscription');
    const body = buildRenewalBody(tier, customerName, customerEmail, periodEnd);

    console.log('Stripe paid (invoice.paid renewal):', {
      tier, customerName, customerEmail, amountCents,
      billing_reason: invoice.billing_reason,
      invoice_id: invoice.id,
    });
    await sendNtfy(body, 'Renewal paid');

    res.status(200).json({
      received: true,
      type: 'invoice.paid',
      tier,
      customer: customerName || customerEmail || null,
    });
    return;
  }

  console.log('Ignoring event type:', event.type);
  res.status(200).json({ received: true, ignored: event.type });
}
