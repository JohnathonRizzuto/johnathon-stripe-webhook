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

// Map a Stripe amount + mode to the four pricing tiers from CLAUDE.md.
// If the price doesn't match a known tier, fall back to "$XX.XX" formatting.
function tierFromAmount(amountCents: number, mode: string): string {
  if (mode === 'subscription') {
    if (amountCents === 2500) return 'Landing Page Hosting ($25/mo)';
    if (amountCents === 5000) return 'Online Store Hosting ($50/mo)';
    return `$${(amountCents / 100).toFixed(2)}/mo recurring`;
  }
  if (amountCents === 25000) return 'Landing Page Launch ($250)';
  if (amountCents === 50000) return 'Online Store Launch ($500)';
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

    const tier = tierFromAmount(amountCents, mode);
    const body = buildNtfyBody(tier, customerName, customerEmail);

    console.log('Stripe paid (checkout.session.completed):', {
      tier, customerName, customerEmail, mode, amountCents,
    });
    await sendNtfy(body, 'Money landed');

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
