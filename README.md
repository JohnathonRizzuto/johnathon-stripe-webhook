# johnathon-stripe-webhook

A tiny Vercel serverless function that listens for Stripe payments and pings your phone via ntfy when money lands.

**What it does:** Stripe sends every payment event to this endpoint. The function verifies it's really from Stripe (using a signing secret), looks at the amount + mode, figures out which tier the payment is for, and POSTs a one-line message to `ntfy.sh/johnathon-builds-2026`. Your phone buzzes within seconds with something like:

> **Money landed**
> Stripe just paid: Landing Page Launch ($250) from Jane Doe. Click Paid in the dashboard.
> [Open Dashboard]

That's it. No database, no UI, no third-party service. The endpoint is free to run on Vercel forever.

---

## Setup (one time, ~10 minutes)

### 1. Open a PowerShell terminal in this folder

```powershell
cd C:\Users\johnn\business-site-template\stripe-webhook
```

### 2. Make sure prerequisites are installed

You need three CLIs. Check each one:

```powershell
node --version    # need 18 or higher
gh auth status    # need gh logged in
vercel --version  # need vercel CLI installed
```

If `vercel` isn't installed: `npm install -g vercel` then `vercel login`.
If `gh` isn't authenticated: `gh auth login`.

### 3. Run the deploy script

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

It will:
- `npm install` the dependencies
- Initialize git, create a GitHub repo (`johnathon-stripe-webhook`), push the code
- Deploy to Vercel (will prompt for project linking the first time — accept the defaults)
- Print the production URL and the 6-step "next steps" you do manually

### 4. Configure Stripe (manual)

The deploy script tells you to:

1. Go to **Stripe Dashboard → Developers → Webhooks → Add endpoint**
2. Paste the URL it printed (looks like `https://johnathon-stripe-webhook.vercel.app/api/stripe-webhook`)
3. Select event: `checkout.session.completed` (you can add more later — `invoice.paid` for recurring is a good next one)
4. Click **Add endpoint**, then click into it, then **Reveal** the signing secret. Copy it.

### 5. Paste secrets into Vercel

```powershell
vercel env add STRIPE_WEBHOOK_SECRET production
# paste the whsec_... value when prompted

vercel env add STRIPE_SECRET_KEY production
# paste a Stripe restricted API key (Dashboard > API keys > Create restricted key,
# only check "Webhook endpoints" permission, then reveal and paste the rk_live_...)
```

### 6. Redeploy so the new env vars take effect

```powershell
vercel --prod --yes
```

### 7. Test it

Back in Stripe Dashboard → your webhook → **Send test webhook** → pick `checkout.session.completed` → **Send test webhook**.

Your phone should buzz within 5 seconds with the "Money landed" notification. If it doesn't, see Troubleshooting below.

---

## What you can change later

**Add more event types.** In `api/stripe-webhook.ts`, the function currently only handles `checkout.session.completed`. To get a ping when a recurring subscription renews, add an `else if (event.type === 'invoice.paid')` branch. Same pattern for `charge.refunded`, `customer.subscription.deleted`, etc.

**Change the ntfy message.** Look for `buildNtfyBody()` in the function. Edit the string, commit, push. Vercel auto-deploys.

**Map specific Payment Links to specific tier names.** Right now the function maps by amount: $250 = "Landing Page Launch," $25 = "Landing Page Hosting," etc. If you ever have two tiers at the same price, you'd have to look at the `payment_link` or `metadata` field on the session. Stripe Payment Links support adding `metadata` to each link — you could set `tier: "barbershop_premium"` and read it in the function.

**Map a payment back to a specific site.** Today the ping says "click Paid in the dashboard" but doesn't tell you WHICH site. That requires the client to identify themselves at checkout (Stripe's "Custom fields" feature, or unique Payment Links per client). Worth doing once you've sold ~10 sites and the dashboard has too many to scan.

---

## Troubleshooting

**Phone didn't buzz on the test webhook.**

1. Check Stripe Dashboard → your webhook → **Recent events**. If the most recent attempt shows `200` in green, the function ran fine — your phone subscription is the problem. Open the ntfy app on your phone and confirm `johnathon-builds-2026` is subscribed with notifications enabled.
2. If the recent attempt shows `400` or `500`, click into it to see the response body. That's the function's error message.
3. Check Vercel function logs: **Vercel Dashboard → johnathon-stripe-webhook → Logs**. Filter by your function and look for `console.error` lines.

**Stripe shows `Signature verification failed`.**

The `STRIPE_WEBHOOK_SECRET` env var is wrong or missing. Re-do step 5 above. Common cause: pasting an extra space or missing the `whsec_` prefix.

**Stripe shows `STRIPE_WEBHOOK_SECRET env var is not set`.**

You set the env var but forgot to redeploy. Run `vercel --prod --yes` again.

**ntfy worked once and then stopped.**

Look in Vercel function logs for any change in behavior. Most likely your `NTFY_URL` env var got changed by accident. The default (no env var set) points to `ntfy.sh/johnathon-builds-2026`, which is what you want.

---

## File map

| File | Purpose |
| --- | --- |
| `api/stripe-webhook.ts` | The function. Verify, parse, ping. |
| `package.json` | Declares `stripe` and `@vercel/node` deps. |
| `vercel.json` | Sets the function's max duration to 10s. |
| `tsconfig.json` | TypeScript config — strict mode, ES2022. |
| `.gitignore` | Excludes `node_modules/`, `.env*`, `.vercel/`. |
| `.env.example` | Template showing which env vars you need. |
| `deploy.ps1` | One-shot installer / deployer. |
| `README.md` | This file. |

---

## Future automations that bolt onto this same function

(From the payment gap report.)

- **G3 — Owner contact fields:** Once `.meta.json` has `ownerEmail`, you can look up which site this payment is for by matching `session.customer_details.email` against your sites.
- **G4 — Auto "convert to live" reminder:** Add a second ntfy fired 15 minutes after the payment, saying "Run `edit {slug}` to convert the demo to live."
- **G5 — Per-site revenue tracking:** Once you can map a payment to a site (G3), write the amount to a `paid-sites.json` file in this project. The dashboard fetches it on load.

Each of those is "add ~20 lines to the function and redeploy" — same env vars, same setup, no new infrastructure.
