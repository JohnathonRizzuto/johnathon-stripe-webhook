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
| `api/stripe-webhook.ts` | The webhook. Verify, parse, ping ntfy, fire welcome email. |
| `api/send-email.ts` | Gmail SMTP sender. POST endpoint authed by `X-Send-Key`. |
| `package.json` | Declares `stripe`, `nodemailer`, and `@vercel/node` deps. |
| `vercel.json` | Sets max duration for both functions. |
| `tsconfig.json` | TypeScript config — strict mode, ES2022. |
| `.gitignore` | Excludes `node_modules/`, `.env*`, `.vercel/`. |
| `.env.example` | Template showing which env vars you need. |
| `deploy.ps1` | One-shot installer / deployer. |
| `README.md` | This file. |

---

## Email automation -- /api/send-email + auto-welcome

This project hosts a SECOND Vercel function: `api/send-email.ts`. It sends transactional email via Gmail SMTP using a Google App Password. The Stripe webhook automatically calls it on every successful checkout to fire a welcome email to the customer. The dashboard also calls it directly when you click "Send Now" in the email preview modal.

### One-time setup (~5 min)

**1. Generate a Gmail App Password.**

Requires 2-Step Verification on your Google account. If you haven't turned it on, do that first at https://myaccount.google.com/security.

Then go to https://myaccount.google.com/apppasswords:

- App name: `johnathon-builds-email`
- Click **Create**
- Copy the 16-character password it shows (spaces are fine, nodemailer trims them). It's only shown once.

**2. Pick a SEND_EMAIL_KEY.**

Any long random string. This is a shared secret that authorizes the dashboard browser to call `/api/send-email`. Treat it like a password. Easy way to generate one (works on Windows PowerShell 5.1 and 7+):

```powershell
$bytes = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); [Convert]::ToBase64String($bytes)
```

**3. Paste both into Vercel env vars.**

```powershell
vercel env add GMAIL_USER production
# paste: johnnyrizzuto125@gmail.com

vercel env add GMAIL_APP_PASSWORD production
# paste: the 16-char App Password from step 1

vercel env add SEND_EMAIL_KEY production
# paste: the random string from step 2
```

**4. Redeploy.**

```powershell
vercel --prod --yes
```

**5. Test the endpoint with curl.**

```powershell
$endpoint = "https://<your-project>.vercel.app/api/send-email"
$key = "<your SEND_EMAIL_KEY>"
$body = @{
  to      = "johnnyrizzuto125@gmail.com"
  subject = "Test from send-email endpoint"
  body    = "If you see this in your inbox, the endpoint works."
} | ConvertTo-Json
Invoke-WebRequest -Uri $endpoint -Method POST `
  -ContentType "application/json" `
  -Headers @{ "X-Send-Key" = $key } `
  -Body $body -UseBasicParsing
```

Should return `{"ok":true,"messageId":"..."}` and the email lands in your inbox within seconds.

### How the dashboard uses it

In `dashboard.html`, every business row's Email button opens a preview modal with two send options:

- **Open in Mail** — opens a `mailto:` draft in Mail.app on Mac (same as before)
- **Send Now** — POSTs to `/api/send-email`, sends immediately via Gmail SMTP

First time you click Send Now in any browser, two prompts ask for:
1. The endpoint URL (`https://<your-project>.vercel.app/api/send-email`)
2. The SEND_EMAIL_KEY

Both are stored in that browser's localStorage. If the key is rejected (401), it's auto-cleared and the next send re-prompts -- easy way to rotate.

### How the welcome email auto-fires

The Stripe webhook handler (`api/stripe-webhook.ts`) now calls `/api/send-email` after every successful `checkout.session.completed`. The email body is tier-specific (Landing Page Launch gets a "your site is next" message, Online Store Launch gets a store-flavored one, subscriptions get a hosting-active confirmation). Customer replies go to your Gmail inbox.

If `SEND_EMAIL_KEY` isn't set, the welcome email step is skipped silently and the ntfy still fires.

### Templates

The dashboard ships with 7 starter templates: Initial outreach, Follow-up nudge, Closing (send Stripe link), Welcome after payment, Photo request, Site is fully live, Hosting subscription nudge. All editable from the "Manage templates" button in the email picker popover. Add new ones by clicking + Add, or edit existing ones inline. Template placeholders: `{name}`, `{town}`, `{type}`, `{vercelUrl}`, `{phone}`, `{address}`.

### Rotating the App Password

Google occasionally invalidates App Passwords. When it happens, sends fail with `Invalid login`. To rotate:

1. Generate a new App Password (same steps as above)
2. `vercel env rm GMAIL_APP_PASSWORD production` then `vercel env add GMAIL_APP_PASSWORD production` (paste new value)
3. `vercel --prod --yes`

No dashboard changes needed -- the secret lives only on the server.

---

## Cross-device sync -- /api/state + Redis Cloud

The dashboard syncs business statuses, owner emails, video URLs, DNC list, email templates, and other state across PC + Mac + iPhone via a single Redis blob, fronted by this project's `/api/state` endpoint. Backed by Redis Cloud (provisioned via the Vercel Marketplace), connected via the `redis` (node-redis) npm package.

### One-time setup (~5 min)

1. **Install the Redis integration.** Vercel dashboard -> Integrations -> Marketplace -> search "Redis" -> click the Redis listing -> Install. Pick the free **Essentials** plan, sign in / create a Redis Cloud account (free, no credit card), pick US East region, name it whatever you like (e.g. `jb-state`), and connect it to the `stripe-webhook` project. Vercel auto-adds a `REDIS_URL` env var (and possibly `REDIS_PASSWORD`, `REDIS_HOST`, `REDIS_PORT` -- the endpoint only needs `REDIS_URL`).

2. **Install the new dependency and redeploy:**

   ```powershell
   cd C:\Users\johnn\business-site-template\stripe-webhook
   npm install
   vercel --prod --yes
   ```

3. **Redeploy the dashboard** so the client-side sync code goes live:

   ```powershell
   cd C:\Users\johnn\business-site-template\dashboard-deploy
   powershell -ExecutionPolicy Bypass -File deploy-dashboard.ps1
   ```

4. **First-load per device:** open the dashboard, scroll to Email + Combined Link config card, confirm the endpoint + `SEND_EMAIL_KEY` are saved. Sync runs automatically from there. The header shows `synced Xm ago` next to the theme toggle when it's working, or `sync off` if creds aren't configured.

### What syncs

See the `SYNC_KEYS` whitelist in `dashboard.html`. Highlights: business statuses (built/pitched/closed/paid), revenue tracker, owner emails, per-business video URLs, soft-deleted sites, hidden routes, email templates, DNC list, Stripe portal URL, Calendly URL.

### What stays per-device

- `dashboard-theme-v1` (light/dark preference)
- `jb-send-email-endpoint-v1` (bootstrap, needed to talk to sync API)
- `jb-send-email-secret-v1` (shared secret -- never round-trips through sync)
- Visual editor's per-browser GitHub token

### Endpoints

- `GET /api/state` -- returns `{ state, ts }`
- `POST /api/state` -- body = object map of keys to values; merges into existing
- `DELETE /api/state` -- nukes everything (only use for testing)

All three require the `X-Send-Key` header matching `SEND_EMAIL_KEY`.

### Troubleshooting

- **Header shows `sync off`**: the Email + Combined Link config card needs the send-email endpoint URL + `SEND_EMAIL_KEY` filled in. Save those, refresh the page.
- **Changes not appearing on the other device**: hard-refresh (Cmd/Ctrl+Shift+R). Writes debounce 1.5 sec, so wait at least 2 sec after a change before checking another device.
- **`Server misconfigured: SEND_EMAIL_KEY not set.`**: the env var isn't set on Vercel. Add it via the Vercel dashboard or `vercel env add SEND_EMAIL_KEY production`, then redeploy.

---

## Future automations that bolt onto this same function

(From the payment gap report.)

- **G3 — Owner contact fields:** Once `.meta.json` has `ownerEmail`, you can look up which site this payment is for by matching `session.customer_details.email` against your sites.
- **G4 — Auto "convert to live" reminder:** Add a second ntfy fired 15 minutes after the payment, saying "Run `edit {slug}` to convert the demo to live."
- **G5 — Per-site revenue tracking:** Once you can map a payment to a site (G3), write the amount to a `paid-sites.json` file in this project. The dashboard fetches it on load.

Each of those is "add ~20 lines to the function and redeploy" — same env vars, same setup, no new infrastructure.
