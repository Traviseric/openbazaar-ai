# OpenBazaar.ai

> ⚡ **Active handoff: read `HANDOFF.md` (repo root) first** — AWS App Runner deploy to marketplace.teneo.io, planned not executed as of 2026-05-21 (D:→E: migration).

Open-source marketplace for creators, freelancers, and AI agents. Three pillars: product marketplace, gig platform, agent services. Dual-mode payments (Stripe + crypto), federation network, zero platform fees. Public repo — content generation lives in teneo-production (private).

For Teneo-generated brands, OpenBazaar consumes public-safe projections from the Brand Artifact Manifest (`openbazaarCreateStorefront`, `openbazaarPublishBook`) and returns storefront/listing/order state back to Teneo. It should not own private source material, prompts, campaign strategy, chat config, analytics truth, or HES workforce governance.

## Lookup Table

| Concept | Files | Search Terms |
|---------|-------|--------------|
| Server Entry | marketplace/backend/server.js | express, app, listen, PORT |
| Routes | marketplace/backend/routes/ | checkout, admin, brands, network, auth |
| Services | marketplace/backend/services/ | email, lulu, audit, order, health |
| Database | marketplace/backend/database/schema.sql, init.js | sqlite, CREATE TABLE, orders |
| Auth System | marketplace/backend/auth/, routes/auth.js | AuthProvider, magic link, OAuth, session |
| Teneo Auth SSO | See C:\code\.claude\TENEO-AUTH-SETUP.md Part 2B | OAuth 2.0, PKCE, JWT, teneo-auth, SSO |
| Nostr/Alby Auth | Port from C:\code\arxmint\lib\nostr-auth.ts | NIP-07, NIP-98, Alby, nos2x, window.nostr |
| Frontend | marketplace/frontend/ | brand-manager, cart, checkout, template |
| Landing Site | openbazaar-site/ | index.html, style.css, main.js |
| Brand System | marketplace/frontend/brands/ | config.json, catalog.json, variables |
| Course Module | course-module/ | progress, module, lesson |
| Funnel Module | funnel-module/ | funnel, landing, template |
| Setup Wizard | setup-wizard/index.html | wizard, configure, setup |
| Payments | routes/checkout.js, routes/cryptoCheckout.js | stripe, bitcoin, lightning, monero |
| Storefront API | routes/storefront.js | catalog, product, fulfill, checkout, ArxMint |
| Fulfillment System | routes/merchantFulfillment.js, services/printfulFulfillmentProvider.js, services/manualFulfillmentProvider.js | multi-tenant, Printful, connect, sync, webhook, merchant, shipping rates |
| Fulfillment Dashboard | marketplace/frontend/merchant-fulfillment.html | connect Printful, products, orders, tracking, price editing |
| Fulfillment DB | database/schema.sql (merchant_fulfillment_providers, fulfillment_products, fulfillment_orders) | credentials_encrypted, merchant_id, provider, sync |
| Credential Encryption | services/credentialEncryption.js | AES-256-GCM, FULFILLMENT_ENCRYPTION_KEY, encrypt, decrypt |
| Payment Providers | services/paymentProvider.js, services/arxmintProvider.js | PaymentProvider, ArxMint, createCheckout, webhook |
| Bazaar Strategy | te-btc/internal/arxmint-internal/BAZAAR_STRATEGY.md | bazaar, flywheel, merch, flagship |
| Federation | routes/network.js, network-registry.json | node, peer, discovery, revenue share |
| Gig Platform | docs/OPENBAZAAR_AI_SPEC.md | gigs, jobs, proposals, contracts, escrow |
| Docker | docker-compose.yml, Dockerfile | container, nginx, redis |
| Config | .env.example, marketplace/backend/.env.example | STRIPE, SESSION_SECRET, EMAIL |
| Component Library | marketplace/frontend/components-library/, COMPONENT_MANIFEST.json | component, template, {{VARIABLE}}, hero, CTA |
| AI Builder Strategy | docs/development/AI_BUILDER_STRATEGY.md | natural language, page builder, Claude Code |
| AI Discovery | marketplace/backend/routes/discovery.js, docs/features/AI_DISCOVERY_ENGINE.md | semantic search, embeddings, knowledge graph |
| ArxMint Integration | services/arxmintProvider.js, services/arxmintService.js | L402, ecash, Lightning, PaymentProvider, bazaar |
| Docs | docs/ (75+ files by category) | architecture, deployment, features |
| Teneo ecosystem loop | `E:\TE-Code\.claude\strategy\TENEO_ECOSYSTEM_VISION.md`, `E:\TE-Code\teneo-production\specs\ONE-CLICK-BRAND-GENERATOR-INDEX.md`, `E:\TE-Code\MarketingOS\campaigns\teneo-production\TENEO_MARKETINGOS_FLYWHEEL.md`, `E:\TE-Code\ai-assistant\docs\architecture\HUMAN_EMULATION_INDEX.md` | Brand Artifact Manifest, OpenBazaar projection, publish-storefront, publish-book, marketplace sale, MarketingOS growth, HES workforce |

## Stack

- Runtime: Node.js 18+
- Framework: Express.js
- Database: SQLite (Postgres-ready)
- Payments: Stripe + ArxMint (Lightning/ecash)
- Auth: Magic links, OAuth SSO, Nostr NIP-07
- Frontend: Vanilla HTML/CSS/JS (no framework)
- Email: Nodemailer
- Print/POD: Lulu API + Printful (multi-tenant)
- Deploy: Docker, Vercel (frontend), Render (backend)

## Commands

```bash
npm start                                          # Production server (port 3001)
npm run dev                                        # Dev with nodemon auto-restart
node marketplace/backend/database/init.js          # Init/reset database
node marketplace/backend/scripts/create-real-data.js  # Load authentic book data
node marketplace/backend/scripts/generate-password-hash.js --generate  # Admin password
node test-api.js                                   # Test API endpoints
node test-purchase-flow.js                         # Test purchase flow
```

## Conventions

- Public repo: never commit .env, .db, .sqlite, PDFs, claude-files/, teneo-express/
- Brand configs: each brand gets config.json + catalog.json in frontend/brands/
- Routes: one file per domain (checkout, admin, brands, network, auth)
- Services: business logic separate from routes
- Auth: pluggable providers (local magic link OR teneo-auth SSO OR Nostr)
- Dual-mode: primary (Stripe) auto-fails-over to fallback (crypto)
- Landing site: openbazaar-site/ (vanilla HTML, deployed to Vercel)

## Current Focus

First integration: ArxMint Bazaar (arxmint.com/bazaar) — a live merch store built with OpenBazaar.ai, payments via ArxMint Lightning. See te-btc/internal/arxmint-internal/BAZAAR_STRATEGY.md for the full plan. Storefront API (`/api/storefront/catalog`, `/api/storefront/fulfill`) is built and ready for ArxMint to consume.

See docs/ROADMAP.md for strategic priorities. See docs/OPENBAZAAR_AI_SPEC.md for the full site spec including gig platform and agent services.

## TE Code Ecosystem Capabilities

This project is part of the **TE Code ecosystem**. When you build, fix, or break callable capabilities, update the central registry.

**Registry Location**: `E:\TE-Code\CAPABILITIES.yaml`

### When to Update CAPABILITIES.yaml
1. **You add a new callable feature** → Add to your project's section with status `experimental`
2. **You fix a broken capability** → Update status or remove `# BROKEN` note
3. **You break something** → Add `# BROKEN: reason` or downgrade status
4. **You depend on another project** → Add yourself to their `consumers:` list
5. **You claim a planned capability** → Add to `planned:` section with your project name

### Before Adding a Capability
- Is it PROVEN WORKING (not just planned)?
- Can other projects actually call it?
- Is the input/output documented?

Read the full instructions at the top of `CAPABILITIES.yaml` before making changes.
