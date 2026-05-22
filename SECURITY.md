# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenBazaar.ai, please report it responsibly:

- **Email:** security@teneo.io (or use a private channel — do NOT open a public GitHub issue)
- **Encryption:** if you need an encrypted channel, request a PGP key via the same email
- **Response time:** we aim to acknowledge reports within 48 hours and provide a status update within 7 days

### What to include in your report

- A description of the issue and its potential impact
- Steps to reproduce, including any specific configuration / environment details
- Affected versions / commits if known
- Suggested mitigation if you have one in mind

We will credit reporters in release notes unless they prefer to remain anonymous.

## Coordinated disclosure

We follow a 90-day coordinated disclosure timeline:

1. Issue reported privately
2. We confirm, scope, and develop a fix
3. Fix is released with a private CVE (where applicable)
4. Reporter and project agree on a public disclosure date
5. Public disclosure (advisory + patched release notes)

## Out of scope

- Theoretical attacks without a practical proof-of-concept
- Reports against deployed instances we don't operate (e.g., third-party self-hosted forks)
- Issues in dependencies that already have a public CVE — please report those upstream
- Social engineering or phishing of project maintainers

## If you find a real secret in this repo

If you find what looks like a real API key, password, certificate, or other secret committed in this repository (including in historical commits, env-var sample files, or test fixtures):

**DO NOT** post it publicly. Email security@teneo.io immediately with:
- The file path and line number (or commit SHA)
- A redacted screenshot or fragment is fine — we don't need the full secret

We will rotate the credential and force-push history if necessary. Reporters who responsibly disclose committed secrets are credited.

## Operating an OpenBazaar.ai instance

If you self-host this code:

- **Never commit real secrets to your fork.** Use `RENDER_ENV_VARS.txt` / `deploy/aws-app-runner/AWS_ENV_VARS.txt` as templates only — fill values in your platform's secrets manager.
- **Generate fresh values** for `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, and service keys. Don't reuse anything from the upstream repo.
- **Subscribe to release notes** to get security patches.
- **Run `npm audit` regularly** and apply patches promptly.
- **Use restricted Stripe keys** scoped to the minimum permissions your deployment needs.
- **Validate webhooks** — the codebase uses `STRIPE_WEBHOOK_SECRET` for signature verification; make sure yours is set.

## Reporting non-security bugs

For non-security bugs, please open a public GitHub issue. Use this channel only for security-sensitive reports.
