# PARKED — openbazaar-ai deploy (until 2026-07-10)

**Parked:** 2026-06-10 by Activation Ops, per ecosystem audit (`.claude/audits/ecosystem-operating-audit-2026-06-10/FOUNDER-OPERATING-BRIEF.md` — "What to Ignore for 30 Days").
**Why:** Code is deploy-ready (~517 tests passing, full App Runner playbook in `deploy/aws-app-runner/`), but launch adds ~$75/mo fixed cost and zero revenue-loop value this month. The four blocking decisions are founder-only; rather than leak attention, they are pre-answered below so un-parking is a one-line approval.

## The 4 decisions — defaults pre-selected

| # | Decision | Pre-selected default | Rationale |
|---|---|---|---|
| 1 | Subdomain | `marketplace.teneo.io` | Matches deploy playbook assumption; keeps funnel under teneo.io; `openbazaar.ai` stays reserved for V3 federation discovery |
| 2 | Supabase plan | Free tier for dev/staging now; **Pro ($25/mo) only at production launch** | Free is sufficient until live traffic; Pro is a hard launch gate, not a today-cost |
| 3 | AWS region | `us-west-2` | Same region as existing teneo-production Lambdas and vault `AWS_DEFAULT_REGION`; account consistency + latency |
| 4 | DNS provider | Whichever currently serves `teneo.io` (one CNAME: `marketplace` → App Runner domain) | No migration needed; `deploy/aws-app-runner/dns-setup.md` has per-provider steps |

## To un-park (founder, 1 line)

Reply "approve openbazaar defaults" (or amend any row above). Then any agent can execute `deploy/aws-app-runner/README-DEPLOY.md` end-to-end in ~1–2 days; the only human steps left are the DNS CNAME (2 min) and the Supabase Pro upgrade click at launch.

## Auto-revive

If not un-parked by **2026-07-10**, re-evaluate against revenue evidence (did any flywheel close? does ArxMint Bazaar need the storefront API?). Do not extend the park silently — re-decide.
