# HANDOFF: Marketplace AWS Deploy (openbazaar-ai → marketplace.teneo.io)

**Status:** UNCLAIMED
**Written:** 2026-05-21 (before D: → E: drive migration)
**Repo:** openbazaar-ai (MIT, public GitHub — `github.com/Traviseric/openbazaar-ai`)

---

## Goal

Deploy this open-source marketplace to AWS App Runner at `marketplace.teneo.io` so it becomes Teneo's canonical hosted instance. Posture 3: Teneo (teneo-production) is the book factory + control plane; this repo is the public commerce runtime. Same code is forkable by community self-hosters (federation flywheel later).

## Current state

**Code is ~production-grade.** 40 test suites / 517 tests passing (per README, March 2026). Stripe + magic-link auth + AI discovery + multi-brand storefronts + Lulu drop-ship routes all implemented in `marketplace/backend/`. The live `openbazaar.ai` (Vercel) currently serves ONLY the static landing site — the Express backend (`marketplace/backend/server.js`) is NOT deployed anywhere yet. That's the gap.

**Deploy plan: WRITTEN, not executed.** New directory `deploy/aws-app-runner/` contains the full playbook.

## Exact next steps (in order)

1. **Travis answers 4 prereqs:** subdomain confirmed (`marketplace.teneo.io`), Supabase plan, AWS region (`us-west-2`), DNS provider for teneo.io.
2. **Step 1 — Supabase Postgres** (~1hr): create project, get pooler connection string, run `marketplace/backend/database/setup.js`. ⚠️ Verify Postgres migration exists — code may be SQLite-first; check `marketplace/backend/database/`.
3. **Step 2 — ECR + App Runner** (~2–3hr): build the existing `Dockerfile`, push to ECR, create App Runner service (1 vCPU / 2GB, min 1 instance), health check `/api/health`.
4. **Step 3 — DNS + service keys** (~1hr): CNAME `marketplace.teneo.io` → App Runner, generate the mutual service-key, wire into teneo-production's `marketplace-api` + `marketplace-fulfillment-callback` Lambdas, configure Stripe webhook.
5. **Step 4 — first book via CANONICAL path** (~2hr, requires teneo-production Phase 2 done first): create Brand Artifact Manifest → `publish-storefront` → `publish-book` actions. NOT the legacy `submit-book` (orphan listings). Tactical fallback documented in README for infra-only smoke test.
6. **Step 5 — author UX** is deferred to Phase 3 (`BusinessKitPage.jsx` already in flight in teneo-production).

## Key files

| File | What |
|---|---|
| `deploy/aws-app-runner/README-DEPLOY.md` | **START HERE** — 5-step playbook, generic OSS guide with Teneo as worked example, cost (~$50/mo), rollback |
| `deploy/aws-app-runner/AWS_ENV_VARS.txt` | Full env-var manifest (placeholders → Secrets Manager) |
| `deploy/aws-app-runner/DEPLOYMENT_BOUNDARIES.md` | What's OSS-public vs operator-private. 5 operational discipline rules. READ before committing anything. |
| `deploy/aws-app-runner/dns-setup.md` | CNAME instructions per DNS provider |
| `deploy/aws-app-runner/apprunner.yaml` | Source-based fallback config (ECR image-based is preferred) |
| `SECURITY.md` | Responsible disclosure + "found a secret in repo" process |
| `marketplace/backend/server.js` | Express entrypoint; route inventory |
| `Dockerfile` | Already correct (Node 18 alpine, port 3001, /api/health) |

## Uncommitted files?

Committing this session: `SECURITY.md`, `deploy/aws-app-runner/` (5 files), `HANDOFF.md`, `CLAUDE.md` pointer. **`RENDER_ENV_VARS.txt` edit (secret rotation) is gitignored** — git doesn't track it, but the on-disk file now has placeholders instead of the leaked test Stripe key + admin hash. Anyone with the old git history still sees the leaked values → **rotate the actual Stripe test key + admin password in Stripe/your dashboard** (the values are burned).

## Gotchas

- **This is a PUBLIC OSS repo.** Never commit real secrets. All operator values → AWS Secrets Manager. See DEPLOYMENT_BOUNDARIES.md.
- **The live `openbazaar.ai` is landing-only.** `/api/published/books` returns 500 because no backend is deployed. Don't assume the API works until App Runner is up.
- **Pin deploys to git tags** (`v0.1.0`), never `main` — prevents surprise upstream breakage in production.
- **Branding via env vars only** (`MARKETPLACE_NAME`, etc.) — never hardcode "Teneo" into this OSS code; it breaks the multi-tenant/federation promise.
- **Lulu drop-ship is coded but needs account config** (`LULU_API_KEY` empty disables it). Defer to V2 unless print-on-demand is needed for first sale.
- **Canonical publish path requires teneo-production Phase 2** (`BRAND_ARTIFACT_PUBLISH_ACTIONS_SPEC.md`). Until that ships, only the tactical-fallback orphan path works (infra test only).

## Git

- **Branch:** `main`
- **Ahead/behind:** even with origin/main before commit; my commit makes it ahead 1. NOT pushed.
- **Origin:** `https://github.com/Traviseric/openbazaar-ai.git` — reachable.

## Cross-repo

- Strategy hub + master handoff: `../MarketingOS/HANDOFF.md`
- Phase 2 publish actions: `../teneo-production/.handoff/TODO-marketplace-deploy-and-discovery-specs.md`
