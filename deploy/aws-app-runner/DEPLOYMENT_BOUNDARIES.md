# Deployment Boundaries — OSS Code vs Private Operator Values

**Status:** Architectural boundary doc. Read before deploying.
**Audience:** Anyone deploying OpenBazaar.ai, including the OpenBazaar.ai project itself, Teneo (canonical operator), and community self-hosters.

This doc draws the line between **what's in this open-source repo** and **what stays in your private operator infrastructure**.

It exists because OpenBazaar.ai is an MIT-licensed open marketplace platform that anyone can deploy. The reference deployment is operated by Teneo Inc. at `marketplace.teneo.io`. The deploy guides in this directory work for both — same code, same process, different values.

---

## What lives in THIS REPOSITORY

This repo is public on GitHub. Everything here is MIT licensed and visible to anyone.

**Code:**
- `marketplace/backend/` — Express server, routes, services
- `marketplace/frontend/` — HTML/JS storefront
- `course-module/`, `funnel-module/` — feature modules
- `openbazaar-site/` — the canonical marketing/landing site for the project

**Deployment templates:**
- `Dockerfile`, `Dockerfile.dev` — generic, single-instance
- `deploy/render.yaml`, `deploy/railway.json`, `deploy/netlify.toml`, `deploy/vercel.json` — platform-specific deploy configs
- `deploy/aws-app-runner/` — this directory, AWS deploy guide

**Configuration templates (placeholders only — NO real values):**
- `RENDER_ENV_VARS.txt`, `AWS_ENV_VARS.txt` — env var manifests with `<REPLACE-ME>` placeholders
- `apprunner.yaml` — App Runner runtime config

**Documentation:**
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- `docs/` — open architecture, API documentation, federation protocol

---

## What stays OUTSIDE this repository

These are operator-specific values that NEVER get committed here. Each operator (Teneo, community self-hoster, your own deployment) keeps these in their own private systems.

### Secrets — in your secrets manager

| Secret | Where to store | Why |
|---|---|---|
| `SESSION_SECRET` | AWS Secrets Manager / Render Dashboard / 1Password | One-way cookie signing; rotation invalidates all sessions |
| `ADMIN_PASSWORD_HASH` | Same | Login credential — keep out of git history |
| `STRIPE_SECRET_KEY` | Same | Live payment credential |
| `STRIPE_WEBHOOK_SECRET` | Same | Validates incoming Stripe webhooks |
| `DATABASE_URL` | Same | Production database connection string |
| Service keys for partner integrations | Same | Mutual-auth tokens with other systems |
| OAuth provider client secrets | Same | If using OAuth SSO |

### Operator-specific config — in a private operator-runbook

| Value | Examples |
|---|---|
| Domain name | `marketplace.teneo.io` (Teneo) · `books.example.org` (community fork) |
| AWS account ID | Teneo's vs your own |
| ECR repository URI | `<account>.dkr.ecr.us-west-2.amazonaws.com/openbazaar-ai` |
| Specific Supabase project ref | `xxxxxxxx.supabase.co` |
| Specific Stripe account | Teneo's vs your own connected account |
| Backend integration URLs | `https://api.teneo.io` (Teneo) vs your own backend |
| DNS provider | Cloudflare / Route 53 / etc. — your choice |
| Branding overrides | `MARKETPLACE_NAME`, `MARKETPLACE_TAGLINE`, `SUPPORT_EMAIL` |

### Operator-specific docs — in your own repo / wiki

If you operate this code, write a runbook in YOUR project that:
- Records the specific values above
- Tracks which git tag you've deployed
- Documents your monitoring + alerting setup
- Notes any custom integrations (e.g., Teneo's `teneo-production` Lambdas)

**For Teneo's deployment**, that operator runbook lives at:
`MarketingOS/campaigns/teneo-production/` (with related specs in `teneo-production/specs/`)

It references THIS directory's deploy guide for the mechanical steps and adds Teneo-specific values + integration notes.

---

## How the Teneo deployment differs from a generic self-host

| Aspect | Generic self-hoster | Teneo's deployment |
|---|---|---|
| Domain | `marketplace.example.com` or similar | `marketplace.teneo.io` |
| Compute | App Runner / Render / Railway / Fly — operator's choice | AWS App Runner (matches teneo-production stack) |
| Database | SQLite (dev) or any Postgres (prod) | Supabase Postgres |
| Stripe account | Operator's own | Teneo Inc.'s Stripe account, restricted key per deployment |
| Auth identity | Standalone (admin + magic link) | Bridged to Teneo's Cognito via service-key auth |
| Book generation integration | Manual upload, or your own pipeline | `marketplace-api` Lambda + Brand Artifact Manifest |
| Branding | Custom — operator sets `MARKETPLACE_NAME` etc. | "Teneo Marketplace" + "Knowledge Beyond Boundaries" |
| Federation node ID | `your-marketplace-name` | `teneo-marketplace-canonical` |
| Privacy posture | "Powered by OpenBazaar.ai" footer required (MIT attribution) | Same — Teneo links to the OSS project |

**Key insight:** Teneo's deployment is "one instance of the open protocol," not "the only marketplace." That positioning IS the differentiation. A community fork running at `books.example.org` is structurally equivalent to `marketplace.teneo.io` — they federate via the shared protocol.

---

## Operational discipline rules

These apply to ALL operators, including Teneo:

### Rule 1 — Pin to a specific git tag

App Runner / Render / your platform pulls the image from your ECR / registry. Tag your deploys with semantic versions (`v0.1.0`, `v0.2.0`, etc.) and configure your platform to deploy a specific tag, never `latest` or `main`.

Why: prevents surprise breakage when upstream OSS commits land. You upgrade deliberately, on your schedule, after testing.

```bash
# When you're ready to deploy a new version:
git tag -a v0.2.0 -m "Reason for this version"
git push origin v0.2.0

# Build + push image with that tag:
docker build -t openbazaar-ai:v0.2.0 .
docker tag openbazaar-ai:v0.2.0 <your-ecr>/openbazaar-ai:v0.2.0
docker push <your-ecr>/openbazaar-ai:v0.2.0

# Update your platform to point at the new tag
```

### Rule 2 — Branding via env vars only, never code forks

The codebase exposes `MARKETPLACE_NAME`, `MARKETPLACE_TAGLINE`, `SUPPORT_EMAIL`, `MARKETPLACE_LOGO_URL`, etc. as environment variables. Use those.

If you find a place where the code hardcodes "OpenBazaar.ai" or any brand string, that's a bug — open an issue or PR to parametrize it.

Forking the code to hardcode your brand defeats the open-protocol promise. Future federation breaks. Don't do it.

### Rule 3 — Real secrets never in repo files

Even in `RENDER_ENV_VARS.txt` / `AWS_ENV_VARS.txt`, only placeholders or instructions for generating values. Use your platform's secrets manager.

If you discover a real secret committed in any file (current or historical), report via `SECURITY.md` process — it gets rotated and history rewritten.

### Rule 4 — Attribution footer

MIT doesn't require this, but the OSS-vs-private model depends on it.

Every deployed instance should render somewhere visible (footer is fine):

> Powered by [OpenBazaar.ai](https://openbazaar.ai) · open source · [self-host →](https://github.com/Traviseric/openbazaar-ai)

This is both honest attribution and quiet marketing for the open protocol. Teneo's deployment will include this on every storefront and listing page once the marketplace V0 UI ships.

### Rule 5 — Upstream contributions

Generic improvements (bug fixes, perf, new features that everyone wants) go back to the upstream OSS repo. Operator-specific behavior (Teneo-specific Lambdas, Teneo branding) stays in operator-owned repos.

When in doubt: "would another deployer want this?" If yes, upstream. If no, keep private.

---

## For Teneo's deployment specifically — quick reference

| Question | Answer |
|---|---|
| Where do Teneo-specific operational values live? | AWS Secrets Manager (`openbazaar-ai/*` and `teneo-marketplace/*` namespaces) + `MarketingOS/campaigns/teneo-production/` runbooks |
| Where does the canonical book publishing flow live? | `teneo-production/specs/BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md` — Phase 2 of One-Click Brand Generator |
| Where does the business-kit dashboard UI live? | `teneo-production/React/book-generator/src/pages/BusinessKitPage.jsx` (in flight 2026-05-21) |
| Who is the operational owner? | Travis (founder), with ops handoff to be defined at hire-time |
| What's the deploy approval process? | Manual review per `production.yml` workflow pattern (same as teneo-production) |

If you're a future Claude session reading this: the Teneo operator runbook (with real values) is private; the OSS deploy guide (in this directory) tells you the mechanics. Together they're the complete picture.

---

## What we explicitly do NOT do

To keep the OSS project healthy and the boundary clean:

- ❌ Don't keep operator-specific Lambda code in this repo (Teneo-specific code stays in `teneo-production/`)
- ❌ Don't expose the Brand Artifact Manifest schema or business-kit flow as if it's part of OpenBazaar.ai — those are Teneo's product features that USE this code via service-key API
- ❌ Don't put Teneo's federation node ID, AWS account ID, or specific Stripe account anywhere in this repo
- ❌ Don't write deploy docs assuming "you" are Teneo — write them for any reasonable operator
- ❌ Don't add Teneo-only feature flags to the codebase; if a feature is operator-specific, it should be operator-configured via env vars, not hardcoded
