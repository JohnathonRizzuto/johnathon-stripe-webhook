# deploy.ps1 -- one-shot deploy of the Stripe webhook to GitHub + Vercel.
#
# Run from inside C:\Users\johnn\business-site-template\stripe-webhook:
#   cd C:\Users\johnn\business-site-template\stripe-webhook
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# Prerequisites:
#   - gh CLI installed and authenticated (run `gh auth status` to check)
#   - vercel CLI installed (`npm i -g vercel`) and logged in (`vercel login`)
#   - Node 18+ installed (`node --version`)
#
# What this does:
#   1. Installs dependencies (npm install)
#   2. Initializes git if needed and commits everything
#   3. Creates a public GitHub repo if it doesn't already exist
#   4. Pushes the code
#   5. Runs `vercel --prod` and captures the production URL
#   6. Prints the URL you need to paste into Stripe's webhook config

# PS 5.1 (Windows PowerShell) treats native-command stderr as a terminating
# error when ErrorActionPreference is "Stop", and Vercel writes harmless
# progress messages like "Loading scopes..." to stderr. Use Continue and
# rely on explicit $LASTEXITCODE checks below.
$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$slug = "johnathon-stripe-webhook"

# 1. Install deps
Write-Host "[1/5] Installing dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: npm install failed" -ForegroundColor Red; exit 1 }

# 2. Git init + commit
Write-Host "[2/5] Setting up git..." -ForegroundColor Cyan
if (-not (Test-Path ".git")) {
    git init
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: git init failed" -ForegroundColor Red; exit 1 }
    git branch -M main
}
git add .
git -c user.name="Johnathon" -c user.email="johnnyrizzuto125@gmail.com" commit -m "Deploy: Stripe webhook with ntfy ping" 2>$null
# commit may fail if nothing changed -- that's fine, keep going

# 3. Create or detect GitHub repo
Write-Host "[3/5] GitHub repo..." -ForegroundColor Cyan
$hasRemote = git remote 2>$null
if (-not $hasRemote) {
    gh repo create $slug --public --source=. --push --description "Stripe webhook -> ntfy ping for Johnathon Builds"
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: gh repo create failed" -ForegroundColor Red; exit 1 }
    Write-Host "  Created github.com/JohnathonRizzuto/$slug" -ForegroundColor Green
} else {
    git push
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: git push failed" -ForegroundColor Red; exit 1 }
    Write-Host "  Pushed to existing remote" -ForegroundColor Green
}

# 4. Deploy to Vercel
Write-Host "[4/5] Deploying to Vercel (this may prompt the first time)..." -ForegroundColor Cyan
$deployOutput = vercel --prod --yes 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: vercel deploy failed" -ForegroundColor Red
    Write-Host $deployOutput
    exit 1
}
$deployOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

# Extract the production URL
$prodUrl = ($deployOutput | Select-String -Pattern 'https://[a-z0-9\-]+\.vercel\.app' -AllMatches |
            ForEach-Object { $_.Matches.Value } | Select-Object -Last 1)
if (-not $prodUrl) { $prodUrl = "https://$slug.vercel.app" }

Write-Host ""
Write-Host "[5/5] Deploy complete." -ForegroundColor Green
Write-Host ""
Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host "  NEXT STEPS -- you need to do these manually:" -ForegroundColor Yellow
Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Webhook endpoint URL (paste into Stripe Dashboard):" -ForegroundColor Cyan
Write-Host "     $prodUrl/api/stripe-webhook" -ForegroundColor White
Write-Host ""
Write-Host "2. In Stripe Dashboard > Developers > Webhooks > Add endpoint:" -ForegroundColor Cyan
Write-Host "     URL: $prodUrl/api/stripe-webhook" -ForegroundColor Gray
Write-Host "     Events to send: select 'checkout.session.completed'" -ForegroundColor Gray
Write-Host "     Click Add endpoint, then click into it and reveal the Signing secret." -ForegroundColor Gray
Write-Host "     It looks like: whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Paste that signing secret into Vercel:" -ForegroundColor Cyan
Write-Host "     vercel env add STRIPE_WEBHOOK_SECRET production" -ForegroundColor Gray
Write-Host "     (Paste the whsec_... value when prompted)" -ForegroundColor Gray
Write-Host ""
Write-Host "4. Add your Stripe restricted API key (only needs 'Webhook endpoints'):" -ForegroundColor Cyan
Write-Host "     vercel env add STRIPE_SECRET_KEY production" -ForegroundColor Gray
Write-Host "     (Paste the rk_live_... value when prompted)" -ForegroundColor Gray
Write-Host ""
Write-Host "5. Redeploy so the env vars take effect:" -ForegroundColor Cyan
Write-Host "     vercel --prod --yes" -ForegroundColor Gray
Write-Host ""
Write-Host "6. Test in Stripe Dashboard:" -ForegroundColor Cyan
Write-Host "     Open the webhook endpoint > Send test webhook > checkout.session.completed > Send." -ForegroundColor Gray
Write-Host "     Your phone should buzz within 5 seconds." -ForegroundColor Gray
Write-Host ""
