# Production Configuration Reference

Classic Mart is configured through environment variables. **Never put production secrets in source control, release ZIPs, screenshots, tickets or documentation.** The sanitized release contains `.env.example` only.

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
| `AUDIT_MONGO_URI` | Optional isolated audit DB URI; otherwise audit derives a guarded `*-audit-test` DB |

Before launch run `npm run db:verify`. The application must not be deployed against standalone MongoDB because payment, refund, delivery, B2B and ledger transitions rely on transactions.

## Redis

`REDIS_URL` is optional for the application contract because Mongo-backed sessions are supported. Production Redis is recommended for distributed session/runtime state and must be treated as non-authoritative: commerce truth remains in MongoDB.

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
`SMS_MODE=esms`, `ESMS_API_KEY`, optional approved `ESMS_SENDER_ID`.

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

Production bootstrap credentials must be explicitly supplied. Do not use known/default passwords. A second Super Admin may be configured as an approval reviewer so four-eyes workflows have independent actors from first launch.

After bootstrap, operators should use normal staff-access approval rather than editing MongoDB roles manually.
