# DNS Setup — `marketplace.teneo.io`

Companion to `README-DEPLOY.md` step 3.1. This doc captures what to add at your DNS provider once App Runner gives you the values.

---

## Where is teneo.io's DNS hosted?

Check by running:

```bash
dig +short NS teneo.io
```

Common results and where to add records:

| Nameserver pattern | Provider | Console URL |
|---|---|---|
| `*.cloudflare.com` | Cloudflare | https://dash.cloudflare.com/ → teneo.io → DNS |
| `*.awsdns-*.{com,net,org,co.uk}` | AWS Route 53 | https://console.aws.amazon.com/route53/v2/hostedzones → teneo.io |
| `ns*.dnsimple.com` | DNSimple | https://dnsimple.com/account |
| `*.namecheap.com` | Namecheap | https://ap.www.namecheap.com/Domains/DomainControlPanel/teneo.io/advancedns |
| `*.googledomains.com` | Google Domains / Squarespace | https://domains.squarespace.com/ |

---

## Records to add (after App Runner generates them)

When you click "Link custom domain" in App Runner Console, AWS shows two record sets:

### 1. Domain validation record (one-time)

A `CNAME` like:
```
Type:   CNAME
Name:   _<random-string>.marketplace.teneo.io
Target: _<random-string>.acm-validations.aws.
TTL:    300
```

This is for AWS Certificate Manager to validate domain ownership and issue the HTTPS cert. After validation succeeds (~5 min), the record can technically be removed, but leave it in place so renewals work.

### 2. Service routing record

A `CNAME`:
```
Type:   CNAME
Name:   marketplace
Target: <your-service-id>.us-west-2.awsapprunner.com.
TTL:    300
```

This is the actual traffic record.

---

## Step-by-step (Cloudflare example)

1. Log in to dash.cloudflare.com → select `teneo.io` zone
2. Click "DNS" in left sidebar
3. Click "Add record"
4. For the validation record:
   - Type: `CNAME`
   - Name: `_<random>.marketplace` (paste the full name minus `.teneo.io`)
   - Target: `_<random>.acm-validations.aws.` (paste full target)
   - Proxy status: **DNS only** (orange cloud OFF) — IMPORTANT, validation fails behind Cloudflare proxy
   - TTL: Auto
   - Save
5. Add another record for the service routing:
   - Type: `CNAME`
   - Name: `marketplace`
   - Target: `<your-id>.us-west-2.awsapprunner.com`
   - Proxy status: **DNS only** initially (turn on Cloudflare proxy after deploy validated)
   - TTL: Auto
   - Save

---

## Step-by-step (Route 53 example)

Easier than Cloudflare because AWS-to-AWS:

1. Open Route 53 Console
2. Click `teneo.io` hosted zone
3. Click "Create record"
4. For validation record:
   - Record name: `_<random>.marketplace`
   - Record type: `CNAME`
   - Value: `_<random>.acm-validations.aws.`
   - TTL: 300
   - Save
5. Create second record for service routing:
   - Record name: `marketplace`
   - Record type: `CNAME`
   - Value: `<your-id>.us-west-2.awsapprunner.com`
   - TTL: 300
   - Save

Optional Route 53 enhancement: use an `ALIAS` record (AWS-only) instead of `CNAME` — gives slightly better latency, no extra cost. Set the alias target to the App Runner service directly.

---

## Verification

After DNS records are saved:

```bash
# Should resolve to App Runner's IP (or CNAME chain ending at AWS)
dig +short marketplace.teneo.io

# Health check should return 200
curl -I https://marketplace.teneo.io/api/health

# Marketplace homepage should load
curl -I https://marketplace.teneo.io/
```

If you get `HTTP/2 200`, DNS + ACM cert are working. App Runner Console shows "Custom domain active" status.

If you get `ERR_CERT_AUTHORITY_INVALID` or `SSL_ERROR_NO_CYPHER_OVERLAP`:
- ACM cert may not have been issued yet — wait 10 min
- Validation CNAME might be wrong — double-check exact spelling

---

## What about `openbazaar.ai` as a separate domain?

For now, openbazaar.ai stays as the federation root / open-source landing page. It serves the Vercel-hosted static site (`openbazaar-site/`). When we ship V3 federation, openbazaar.ai will host the federation discovery directory — a directory of all Teneo-compatible nodes including `marketplace.teneo.io` and any community-deployed peers.

That's L3 work. For now: leave openbazaar.ai alone.

---

## Brand-routing decision recap

We picked `marketplace.teneo.io` over alternatives:

| Option | Pro | Con | Decision |
|---|---|---|---|
| `marketplace.teneo.io` (chosen) | Simple DNS (one CNAME), brand-consistent, federation-friendly later | Subdomain context-switch from teneo.io | ✅ |
| `teneo.io/marketplace` | One domain, no subdomain switch | Requires CloudFront path-pattern surgery; risks breaking teneo.io main site | ❌ |
| `openbazaar.ai` (canonical) | Federation-brand-first | Buyer context-switches off teneo.io; dilutes funnel | ❌ |

Revisit this decision at V2/V3 — once federation is real, `openbazaar.ai` may become the right canonical domain. For MVP: `marketplace.teneo.io`.
