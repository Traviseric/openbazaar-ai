# AWS App Runner Deploy Playbook — OpenBazaar.ai

**Audience:** Anyone deploying OpenBazaar.ai to AWS App Runner — community self-hosters AND the canonical operator (Teneo Inc.).
**Status:** Generic deploy guide. Teneo Inc.'s deployment at `marketplace.teneo.io` is included as the worked example throughout.
**Estimated total time:** 1–2 calendar days for infrastructure deploy. ~$50/mo running cost at MVP traffic.

> **📖 Read first:** `DEPLOYMENT_BOUNDARIES.md` in this directory — explains what stays in this OSS repo vs what stays in your private operator infrastructure. Critical before you commit anything.

> **🏛️ Integration note for Teneo-style operators:** If you're integrating OpenBazaar.ai with a separate book-generation backend (like Teneo's `teneo-production`), the canonical book publishing path goes through Brand Artifact Manifest publish actions, NOT direct `marketplace-api/submit-book` calls. See `teneo-production/specs/ONE-CLICK-BRAND-GENERATOR-ARCHITECTURE.md` + `BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md`. For standalone self-hosters with no separate book backend, the built-in admin UI is sufficient. Step 4 below covers both.

> **🚀 Phase 3 status update (2026-05-21):** Teneo's `BusinessKitPage.jsx` UI is in flight in `teneo-production/React/...`. This is Phase 3 of the One-Click Brand Generator — the business-kit operating dashboard. Generic self-hosters don't need this; Teneo operators will use it as the primary surface for invoking Phase 2 publish actions once it ships. Step 5 below documents both paths.

This playbook turns the deploy into a checklist anyone (community self-hoster, Travis, an engineer, future Claude) can execute. Each step has commands, env vars, and exit criteria. **Teneo-specific values appear in `[brackets like this]` throughout — substitute your own when self-hosting.**

---

## Architecture summary

```
                       teneo.io (factory)
                       ──────────────────
                       - Book generation (Lambdas)
                       - Author dashboard (React)
                       - marketplace-api Lambda
                       - marketplace-fulfillment-callback Lambda
                              │
                              │ marketplace.publish-book (service-key auth)
                              ▼
                       marketplace.teneo.io  ← THIS DEPLOYMENT
                       ────────────────────
                       AWS App Runner + Docker
                       - Express server (node backend/server.js)
                       - Stripe + Lightning checkout
                       - Storefront pages (HTML + JS)
                       - AI discovery + page builder
                       - Brand catalogs
                              │
                              │ order-paid / credit-author (service-key auth)
                              ▼
                       Back to teneo.io Lambdas
                       - Entitlement issued
                       - S3 signed URL emailed
                       - Author credits accrued

Data layer:
  Supabase Postgres (production)
  - marketplace tables (books, orders, brands, etc.)
  - Located outside AWS, separate from teneo-production DynamoDB
```

**Why this architecture:** Posture 3 from the marketplace planning sessions — Teneo is the factory, OpenBazaar is the open-source store template, federation comes later. The L2a marketplace IS the L3 federation infrastructure built up incrementally. See `.claude/strategy/TENEO_ECOSYSTEM_VISION.md` for full context.

---

## Prerequisites — what must exist before starting

| Prerequisite | How to verify | Notes |
|---|---|---|
| AWS account with IAM admin access | `aws sts get-caller-identity` returns your account | Should be the same account hosting teneo-production Lambdas (us-west-2 region) |
| Stripe account with API access | Sign in to dashboard.stripe.com | Same account teneo.io uses — we'll create a restricted key |
| Supabase account | sign in to supabase.com | Free tier works for dev; Pro ($25/mo) for production |
| Docker installed locally | `docker --version` | For building + pushing the image first time |
| AWS CLI installed + configured | `aws s3 ls` works | For ECR push commands |
| DNS access to teneo.io | Where teneo.io is registered (Cloudflare? Route 53?) | For adding the `marketplace.teneo.io` CNAME |
| OpenAI API key | check `.env` files for `OPENAI_API_KEY` | Optional but free upgrade from keyword-search fallback |

---

## Step 1 — Supabase Postgres database (1 hour)

App Runner is stateless. The SQLite database that ships with the openbazaar-ai code will be wiped on every container restart. **Production REQUIRES a persistent Postgres.** Supabase is the easiest path.

### 1.1 — Create Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Name: `teneo-marketplace-production`
3. Region: `us-west-2` (matches teneo-production AWS region — keeps latency low)
4. Database password: generate strong one, save to 1Password / AWS Secrets Manager
5. Plan: Free tier for first 2 weeks of testing, then upgrade to Pro ($25/mo) before launching live traffic

### 1.2 — Get connection string

In Supabase Dashboard → Settings → Database:
- Copy the **Connection Pooling** URI (NOT the direct connection — pooler handles serverless better)
- Format: `postgresql://postgres.{ref}:{password}@aws-0-us-west-2.pooler.supabase.com:6543/postgres`
- Save as `DATABASE_URL` in your env-var notes

### 1.3 — Run database setup

Locally (so you don't have to push code yet):

```bash
cd "D:/Travis Eric/TE Code/openbazaar-ai/marketplace/backend"
DATABASE_URL="postgresql://..." node database/setup.js
```

If `database/setup.js` has SQLite-only logic, check `marketplace/backend/database/` for a Postgres migration. If only SQLite exists, this is a **gating issue** — the codebase claims Supabase support but may need migration scripts written. Verify before proceeding.

**Exit criteria:** Connect to Supabase via psql or Supabase Studio → see marketplace tables (`books`, `brands`, `orders`, `customers`, `download_tokens`, etc.).

---

## Step 2 — AWS ECR + App Runner setup (2–3 hours)

### 2.1 — Build + push Docker image to ECR

```bash
cd "D:/Travis Eric/TE Code/openbazaar-ai"

# Create ECR repo (one-time)
aws ecr create-repository \
  --repository-name openbazaar-ai \
  --region us-west-2 \
  --image-scanning-configuration scanOnPush=true

# Get login token
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin \
  <your-account-id>.dkr.ecr.us-west-2.amazonaws.com

# Build (uses existing Dockerfile at repo root)
docker build -t openbazaar-ai:v0.1.0 .

# Tag for ECR
docker tag openbazaar-ai:v0.1.0 \
  <your-account-id>.dkr.ecr.us-west-2.amazonaws.com/openbazaar-ai:v0.1.0

# Push
docker push <your-account-id>.dkr.ecr.us-west-2.amazonaws.com/openbazaar-ai:v0.1.0
```

**Exit criteria:** `aws ecr describe-images --repository-name openbazaar-ai` shows the v0.1.0 image.

### 2.2 — Generate secrets

```bash
# Session secret (64-char hex)
openssl rand -hex 32

# Admin password hash (you set the password)
cd "D:/Travis Eric/TE Code/openbazaar-ai/marketplace/backend"
node scripts/generate-password-hash.js --generate

# Service key for mutual auth between teneo-production and marketplace
openssl rand -hex 32  # save as TENEO_SERVICE_KEYS + OPENBAZAAR_SERVICE_KEY (same value, both sides)
```

Save all three to AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name openbazaar-ai/session-secret \
  --secret-string '<the-hex-string>' \
  --region us-west-2

aws secretsmanager create-secret \
  --name openbazaar-ai/admin-password-hash \
  --secret-string '<bcrypt-hash>' \
  --region us-west-2

aws secretsmanager create-secret \
  --name teneo-marketplace/service-key \
  --secret-string '<the-shared-key>' \
  --region us-west-2
```

### 2.3 — Create restricted Stripe API key

In Stripe Dashboard → Developers → API keys → Create restricted key:

- Name: `Teneo Marketplace (App Runner)`
- Permissions: `Charges: Write`, `Customers: Write`, `Payment Intents: Write`, `Checkout Sessions: Write`, `Webhook Endpoints: Read`
- Save the `sk_live_restricted_*` to Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name openbazaar-ai/stripe-secret-key \
  --secret-string 'sk_live_restricted_...' \
  --region us-west-2
```

### 2.4 — Create App Runner service

Use the AWS Console (Console flow is most reliable first time; can be converted to CDK/CloudFormation later):

1. **App Runner Console → Create service**
2. **Source:** Container registry → Amazon ECR → choose `openbazaar-ai:v0.1.0`
3. **Deployment trigger:** Manual (Automatic later via GitHub Actions)
4. **Service name:** `teneo-marketplace`
5. **Compute:**
   - CPU: 1 vCPU
   - Memory: 2 GB
   - Concurrency: 100
6. **Auto-scaling:** Min 1 / Max 4 (so we don't scale to zero — first-impression latency matters)
7. **Health check:**
   - Protocol: HTTP
   - Path: `/api/health`
   - Interval: 10s
   - Timeout: 5s
   - Healthy threshold: 1
   - Unhealthy threshold: 3
8. **Environment variables:** See `AWS_ENV_VARS.txt` for the full list. Most as plain env vars, secrets pulled from Secrets Manager via ARN references.
9. **Custom domain:** Skip for now — we'll do this in step 3.

**Exit criteria:** App Runner service shows "Running" status. The default URL (`https://xxx.us-west-2.awsapprunner.com`) returns HTTP 200 at `/api/health`.

---

## Step 3 — DNS + service-key wiring (1 hour)

### 3.1 — Point `marketplace.teneo.io` at App Runner

In App Runner Console → Custom domains → Link new custom domain:

1. Domain: `marketplace.teneo.io`
2. App Runner displays CNAME + validation records
3. Add these to teneo.io's DNS provider:
   - `CNAME` record: `marketplace` → `<app-runner-url>.awsapprunner.com`
   - Validation `CNAME` records as shown
4. Wait 5–15 minutes for DNS propagation + ACM certificate issuance
5. App Runner shows "Custom domain active"

**Exit criteria:** `curl -I https://marketplace.teneo.io/api/health` returns HTTP 200.

### 3.2 — Wire service-key chain into teneo-production

Update environment in the existing teneo-production Lambdas:

```bash
# marketplace-api Lambda
aws lambda update-function-configuration \
  --function-name <env>-teneo-marketplace-api \
  --environment "Variables={\
MARKETPLACE_API_URL=https://marketplace.teneo.io,\
OPENBAZAAR_SERVICE_KEY=<the-shared-key>,\
$(existing vars)}" \
  --region us-west-2

# marketplace-fulfillment-callback Lambda
# Already has TENEO_SERVICE_KEYS support — add the new key to the list
aws lambda update-function-configuration \
  --function-name <env>-teneo-marketplace-fulfillment-callback \
  --environment "Variables={\
TENEO_SERVICE_KEYS=<existing-keys>,<the-shared-key>,\
$(existing vars)}" \
  --region us-west-2
```

**Cleaner alternative:** edit the CDK stack at `D:/Travis Eric/TE Code/teneo-production/cdk/app.py` to add these vars, then deploy through the standard `production.yml` workflow.

### 3.3 — Configure Stripe webhook endpoint

In Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://marketplace.teneo.io/api/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `payment_intent.payment_failed`
- Save → Stripe gives you a `whsec_*` signing secret
- Add to App Runner env: `STRIPE_WEBHOOK_SECRET=whsec_...`

**Exit criteria:** Stripe webhook test fires and returns HTTP 200 from `https://marketplace.teneo.io/api/webhooks/stripe`.

---

## Step 4 — First book + smoke test (CANONICAL PATH — 2 hours after Phase 2 ships)

**⚠️ ARCHITECTURE NOTE:** Per `ONE-CLICK-BRAND-GENERATOR-ARCHITECTURE.md`, books must be published through the Brand Artifact Manifest, not via direct `marketplace-api/submit-book` calls. The Manifest publish actions (`POST /brand-artifacts/{manifestId}/publish-storefront` and `/publish-book`) are Phase 2 work — specified in `teneo-production/specs/BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md`. **Step 4 below assumes Phase 2 actions have shipped first.** If Phase 2 isn't done yet, see "Tactical fallback" at the bottom of this step.

### 4.1 — Create Brand Artifact Manifest for the test book

From the existing manifest CRUD Lambda (already live):

```bash
# Get a Cognito access token first
TOKEN="<your-cognito-access-token>"

# Create a manifest for the Energy Ledger sample book
curl -X POST https://api.teneo.io/brand-artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "brand": {
      "name": "Teneo Publishing",
      "slug": "teneo-publishing",
      "tagline": "Knowledge Beyond Boundaries"
    },
    "book": {
      "bookId": "<existing-book-id-from-author-library>",
      "title": "The Energy Ledger",
      "subtitle": "How Civilization Accounts for Truth",
      "wordCount": 53000,
      "chapterCount": 11,
      "priceUSD": 14.99,
      "pdfUrl": "<s3-pdf-url>",
      "coverUrl": "<s3-cover-url>"
    },
    "offers": [{ "type": "book", "priceUSD": 14.99, "name": "The Energy Ledger" }],
    "governance": { "publicSafe": true, "reviewStatus": "approved" }
  }'

# Save the returned manifestId
```

**Exit criteria:** `GET /brand-artifacts/{manifestId}` returns the full manifest with `handoffs.openbazaarCreateStorefront` and `handoffs.openbazaarPublishBook` populated.

### 4.2 — Publish storefront via canonical action

```bash
curl -X POST https://api.teneo.io/brand-artifacts/{manifestId}/publish-storefront \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The orchestrator:
1. Loads the manifest
2. Validates `governance.publicSafe = true`
3. Pulls `handoffs.openbazaarCreateStorefront` (already pre-computed by the shared builder)
4. Calls `marketplace.teneo.io/api/ai-invoke/marketplace.create-storefront` with the projection
5. Writes returned `runtimeStorefrontId` + `publicUrl` back into the manifest
6. Refreshes handoffs and activationPlan

**Exit criteria:** Response includes `storefrontId` and `publicUrl`. `curl https://marketplace.teneo.io/{storefrontSlug}` returns the storefront page.

### 4.3 — Publish book via canonical action

```bash
curl -X POST https://api.teneo.io/brand-artifacts/{manifestId}/publish-book \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Exit criteria:** Response includes `listingId` + `publicUrl`. The Energy Ledger appears on the storefront page at marketplace.teneo.io.

### 4.4 — Test purchase end-to-end (Stripe test mode first)

1. Temporarily switch App Runner's `STRIPE_SECRET_KEY` to a `sk_test_*` key
2. Visit `https://marketplace.teneo.io/{storefrontSlug}` → click "Buy" on The Energy Ledger
3. Stripe checkout opens → use test card `4242 4242 4242 4242`
4. Complete checkout
5. Stripe webhook fires `checkout.session.completed` → handled by openbazaar-ai
6. openbazaar-ai calls back to `https://api.teneo.io/api/ai-invoke/marketplace.order-paid`
7. teneo-production `marketplace-fulfillment-callback` Lambda creates entitlement + S3 signed URL
8. Buyer receives email with download link
9. Click link → PDF downloads

**Exit criteria:** All 9 steps complete. Author credit appears in `dev-teneo-user-credits` table. `manifest['marketplaceListing']['status']` = `'live'`. `manifest['runtimeStatus']['openbazaar']` = `'live'`.

### 4.5 — Switch to live Stripe key

Once 4.4 passes, swap to the `sk_live_restricted_*` key. Run one real $1 purchase to verify live mode.

### Tactical fallback (if Phase 2 actions not yet shipped)

If `BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md` Phase 2 work hasn't completed, you can verify the marketplace deploy works in isolation by directly hitting `marketplace.teneo.io`'s endpoints with a manually-shaped payload. **This creates an orphan listing — DO NOT use this path for real customer-facing books.** Treat it as a deployment smoke test only. Delete the orphan listing once Phase 2 ships and re-publish through the canonical path.

```bash
# ORPHAN PATH — INFRASTRUCTURE TEST ONLY, NOT FOR PRODUCTION USE
curl -X POST https://marketplace.teneo.io/api/ai-invoke/marketplace.publish-book \
  -H "x-service-key: <TENEO_SERVICE_KEYS-value>" \
  -H "Content-Type: application/json" \
  -d '{
    "bookId": "test-orphan-001",
    "title": "Infrastructure Test Listing",
    "priceUSD": 0.01,
    "_orphan_test": true
  }'
```

If this returns 200, the marketplace deploy is healthy. Mark the test listing for deletion. Wait for Phase 2 before publishing real books.

---

## Step 5 — Author UX (deferred to Phase 3 of One-Click)

**Original plan (now superseded):** add a "List direct" button to `PublishedDashboard.jsx`. This was based on a wrong assumption — patching `marketplace-api/submit-book` to bypass Amazon. Per `ONE-CLICK-BRAND-GENERATOR-ARCHITECTURE.md`, the correct UX is a **business-kit operating dashboard** keyed off the Brand Artifact Manifest.

**Phase 3 work (separate spec, deferred):**

The business-kit dashboard surfaces the manifest's readiness states + publish actions:

```text
Your Business Kit — Teneo Publishing

Brand: Teneo Publishing                  ✅ ready
Book: The Energy Ledger                  ✅ finalized
Storefront: marketplace.teneo.io/teneo   ✅ live
Listing: The Energy Ledger ($14.99)      ✅ live
Landing page                             ⏳ generated, not published
Ads campaign                             ⏳ exported to MarketingOS
Chat agent                               ❌ not installed
Analytics                                ❌ not registered

[Publish Storefront] [Publish Book] [Export Campaign] [Install Chat Agent]
```

Per the One-Click spec, this UI lives at `/territories/{territoryId}/business-kit` or `/brands/{brandId}/business-kit`. UI components consume the existing frontend service wrapper at `React/book-generator/src/services/brandArtifactManifestApi.js` (extended in `BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md` to include `publishStorefront`, `publishBook`, etc.).

**Until the Phase 3 UI ships,** Travis can publish books manually via the Phase 2 API endpoints. MVP-scale this is acceptable — first 5–10 books listed manually. UI work comes when scale demands it.

### Effort if Phase 3 ships in parallel: +1 week

The business-kit dashboard is roughly:
- 1–2 day: page route + manifest fetch + render readiness states
- 1–2 day: publish action buttons + loading/error states
- 1 day: regeneration controls for missing assets
- 1 day: integration test + UX polish

**Total: ~1 week beyond Phase 2.** Not blocking the MVP deploy — defer until first 5 manual publishes prove the API path works end-to-end.

---

## Operational concerns

### Cost estimate (monthly)

| Service | Tier | Monthly |
|---|---|---|
| AWS App Runner | 1 vCPU / 2 GB, min 1 instance | ~$50 |
| Supabase Pro | Production tier | $25 |
| Stripe | Per-transaction (2.9% + 30¢) | Variable |
| ECR storage | <1 GB | ~$0.10 |
| AWS data transfer | First 100 GB free | ~$0 at MVP |
| **Total (excl. Stripe fees)** | | **~$75/mo** |

### Logs + monitoring

- **App Runner:** CloudWatch Logs automatically — log group `/aws/apprunner/teneo-marketplace`
- **Express logs:** server.js writes to stdout; CloudWatch ingests
- **Health alerts:** Add CloudWatch alarm on `/api/health` failure (>3 consecutive failures → SNS to support@teneo.io)
- **Stripe events:** Stripe Dashboard → Events tab for webhook delivery audit

### Rollback procedure

App Runner supports image rollback via console:
1. Service → Deployments → choose previous image tag
2. Click "Deploy"
3. Traffic shifts to old version (~5 min)

**To roll back the Lambda env-var changes** (step 3.2), use `aws lambda update-function-configuration` with the prior env-var snapshot (saved before changes via `aws lambda get-function-configuration > backup.json`).

### Scaling beyond MVP

| Load level | Recommended config |
|---|---|
| <1K visits/day | Current — 1 vCPU / 2 GB, min 1 / max 4 |
| 1K–10K visits/day | 2 vCPU / 4 GB, min 1 / max 8 |
| 10K+ visits/day | Move database to RDS Aurora Serverless v2 + ElastiCache for sessions + CloudFront in front of App Runner |

---

## Open decisions Travis owns

1. **Subdomain confirmed?** `marketplace.teneo.io` is the spec assumption. Alternatives: `teneo.io/marketplace` (requires CloudFront work) or `openbazaar.ai` (federation-brand-led, sacrifices funnel cohesion).
2. **Supabase free tier first, or jump to Pro from day 1?** Free tier is fine for first 2 weeks of dev/staging. Production launch requires Pro ($25/mo).
3. **Stripe Connect for V2?** Defer to V2 when first 5+ active authors exist. MVP uses single-seller (Teneo collects, pays authors via `credit-author` flow + manual monthly payout).
4. **Auto-deploy from GitHub vs manual ECR push?** Manual for MVP; GitHub Actions auto-push later when deploy rhythm stabilizes.

---

## Reference files in this directory

- `apprunner.yaml` — App Runner config (for source-based builds; we're using ECR image-based but this is the fallback)
- `AWS_ENV_VARS.txt` — full env var checklist for App Runner Secrets Manager
- `dns-setup.md` — CNAME instructions for `marketplace.teneo.io`

---

## Updates log

- **2026-05-21:** Initial playbook written. Greenfield deployment, no AWS marketplace assets exist yet.
