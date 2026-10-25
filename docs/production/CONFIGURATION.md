# Production Configuration Reference

Classic Mart is configured through environment variables. **Never put production secrets in source control, release ZIPs, screenshots, tickets or documentation.** Releases contain configuration templates, not populated runtime environment files.

## Runtime and public URL

| Variable | Production rule |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Internal application port, normally `3000` |
| `BASE_URL` | Public HTTPS origin, for example `https://mart.example.com` |
| `TRUST_PROXY` | Must match the real reverse-proxy topology; do not blindly trust all proxies |

`BASE_URL` is security-sensitive because it is used for redirects, provider callbacks and generated public URLs.

## MongoDB

Production requires a MongoDB deployment that supports multi-document transactions (Atlas replica set/sharded cluster or an equivalent replica set).

| Variable | Rule |
|---|---|
| `MONGO_MODE` | Production is environment-driven; local bootstrap is not used |
| `MONGO_URI` | Explicit transaction-capable URI |
| `AUDIT_MONGO_URI` | Optional isolated audit DB URI; used only by isolated engineering integration audits, never the live application database |

From the source or clean package, run `npm run db:verify` before launch. That engineering command is deliberately absent from the production ZIP and Docker image; their startup validates transaction-capable MongoDB directly. The application must not be deployed against standalone MongoDB because payment, refund, delivery, B2B and ledger transitions rely on transactions.

## Redis

`REDIS_URL` is mandatory in production for shared sessions and atomic distributed rate limits. Startup and readiness fail closed when it is unavailable. Development can omit Redis and use its local fallback stores. Redis is non-authoritative for commerce: orders, payment state and ledgers remain in MongoDB.

## Cryptographic/security secrets

Generate these independently; do not reuse values:

- `SESSION_SECRET` — at least 32 random characters.
- `TOKEN_PEPPER` — different random secret, at least 32 characters.
- `DATA_ENCRYPTION_KEY` — 32-byte key encoded as 64 hexadecimal characters; protects sensitive stored values.
- `SECURITY_INTEGRITY_KEY` — independent 32-byte/64-hex integrity key; used for HMAC controls such as delivery proof verification.
- `ORIGIN_GUARD_SECRET` — only when an origin guard is enabled behind a trusted proxy/WAF.
- `SIEM_TOKEN` — if using HTTP SIEM export.
- `METRICS_TOKEN` — at least 32 random characters when `/internal/metrics` is enabled.

Rotate any secret that has ever been included in an exported developer ZIP or disclosed outside the trusted operating environment.

## Email and SMS

Production account verification/recovery must use real delivery providers.

SMTP variables:
`MAIL_MODE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.

SMS variables:
`SMS_MODE=yoola`, `YOOLA_API_KEY`.
See [SMS configuration](SMS.md) for account setup and the provider verification scope.

Development may log mail/SMS; production must not pretend a logged message was delivered to a user.

## Pesapal API 3.0

Required for online payment:

- `PESAPAL_SANDBOX=false`
- `PESAPAL_BASE_URL=https://pay.pesapal.com/v3`
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`
- `PESAPAL_IPN_ID`
- `PESAPAL_TIMEOUT_MS`

After the HTTPS application is deployed, run:

```bash
npm run pesapal:register-ipn
```

Store the returned IPN/notification ID in `PESAPAL_IPN_ID`, restart both web and worker processes, and perform a sandbox/live controlled payment verification before opening checkout to users. See `PESAPAL.md`.

## Upload malware scanning

Production must not use `MALWARE_SCAN_MODE=off`.

Recommended:

```text
MALWARE_SCAN_MODE=clamd
CLAMAV_HOST=<private clamd host>
CLAMAV_PORT=3310
```

`clamscan` is supported when the executable is available. Uploaded public images are decoded/re-encoded; sensitive evidence/KYB files remain private and authorization-controlled.

Keep signed definitions updated continuously, or rebuild the local-scanner image
frequently. Each `clamscan` upload uses its native two-day CVD freshness check.
For `clamd`, each upload first checks the loaded database with `VERSION`; missing,
malformed or stale metadata blocks the upload before any file bytes are sent.
The daemon reports a local timestamp without a timezone. The application uses
a conservative 14-hour uncertainty allowance, so a reported timestamp older
than roughly 34 hours is rejected to keep its oldest possible age within 48
hours. This may reject an uncertain database earlier than its real expiry.
Use a private, access-controlled daemon; its protocol is not encrypted by this
application. Version lookup and upload share one 15-second deadline and bounded
responses. `launch:check` also scans a harmless readiness probe with the actual
configured engine. This is separate from clean/EICAR certification with real
signed definitions; a protocol fixture is not that certification.

## Classic AI

The safest default is:

```text
AI_PROVIDER=disabled
```

To enable an external provider configure the API/base/model values in the environment. Provider credentials are never stored in MongoDB. Model/prompt configuration changes that affect production operations use the administrative approval controls provided by the application.

## PWA/push/mobile

Configure push and native-app identifiers only when those integrations are actually deployed. Blank push configuration must produce an honest unavailable state rather than fake delivery success.

## Defence in depth / SIEM / launch scope

Production should use:

- `IDS_ENABLED=true`
- `IPS_ENABLED=true`
- `PRIVILEGED_MFA_REQUIRED=true`
- real `SECURITY_INTEGRITY_KEY`
- SIEM output (`SIEM_MODE=http` or a trusted internal UDP design)
- explicit `LAUNCH_COUNTRIES`, for example `UG` or `UG,KE`
- optional origin guard only when the proxy injects the secret header and direct origin access is network-blocked.

## Metrics

Set `METRICS_TOKEN` to expose `/internal/metrics`. Scrape only from a private monitoring network and send:

```text
Authorization: Bearer <METRICS_TOKEN>
```

Do not place the metrics token in browser JavaScript.

## Administrator bootstrap

Production bootstrap credentials must be explicitly supplied. Do not use known/default passwords. Provision a second independently verified Super Admin by running the trusted bootstrap separately with that operator's own `ADMIN_*` bindings; see [staff provisioning](staged-launch.md#provision-staff-without-an-unfinished-admin-screen). Each operator must enroll their own authenticator so approval workflows have independent actors from first launch.

After bootstrap, operators should use normal staff-access approval rather than editing MongoDB roles manually.
