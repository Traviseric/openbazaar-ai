# Teneo Funnel Imports

Teneo is the first client for OpenBazaar native funnels and courses. Teneo exports public funnel manifests from `React/book-generator/src/data/funnelDefinitions.js`; OpenBazaar imports those manifests into its own funnel, course, checkout, storefront, and observability shapes.

## Source

In `teneo-production`:

```bash
npm run export:openbazaar-funnels
npm run check:openbazaar-funnels
```

The checked-in export files live under:

```text
manifests/openbazaar-funnels/*.json
```

## Import

From the OpenBazaar repo:

```bash
node marketplace/backend/scripts/import-teneo-funnel.js "D:/Travis Eric/TE Code/teneo-production/manifests/openbazaar-funnels/ten-minute-author.json"
```

By default the importer writes normalized native artifacts to:

```text
funnel-module/imports/teneo/<slug>.json
```

To write database records for a local OpenBazaar instance:

```bash
cd marketplace/backend
npm run import:teneo-funnel -- "D:/Travis Eric/TE Code/teneo-production/manifests/openbazaar-funnels/ten-minute-author.json" --db --brand teneo --user teneo-import
```

## Mapping

The importer preserves:

- Funnel runtime blocks as `teneo-runtime:<slug>` drafts.
- Course outline blocks as course modules and text lessons.
- Offer price, checkout route, success route, product type, and metadata keys.
- OpenBazaar storefront surface, listing/catalog seed, proof counters, and fulfillment callback.
- PostHog/GA4 event vocabulary and paid-traffic readiness gates.
- Attribution params that must survive auth, checkout, generation, and fulfillment.

The service entry point is `marketplace/backend/services/teneoFunnelImportService.js`.
