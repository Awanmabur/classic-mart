# OWASP ASVS 5.0 engineering self-review

This is an engineering mapping, not a certification or independent assessment. The launch gate still requires recorded independent review/penetration-test evidence.

| Area | Classic Mart controls | Verification path |
|---|---|---|
| Architecture | server authority, module/service boundaries, threat model, no browser-trusted role/price/stock/payment state | `docs/THREAT_MODEL.md`, integration audit |
| Authentication | Argon2id, lockouts, generic recovery, verified email/phone, TOTP MFA, recovery-code replay controls | identity/MFA tests and audit |
| Session | regeneration after authentication, HttpOnly/SameSite/Secure production cookie, token version, device revocation | auth/session tests |
| Access control | role + ownership/store/org/country/status checks; read-only approved impersonation | route/service tests and integration audit |
| Validation | Zod schemas, unsafe Mongo key rejection, bounded bodies/parameters, upload validation | project/security tests |
| Stored crypto | AES-256-GCM high-risk fields, independent HMAC keys, Argon2id passwords | crypto/security tests |
| Logging | separate audit and integrity-protected security-event streams, request IDs, throttled IPS block-hit telemetry, SIEM retry/dead-letter | `/admin/security`, integration audit |
| Data protection | no PAN/CVV storage, private evidence/KYC media, redaction, no-store protected pages | payment/media/trust tests |
| Communications | HTTPS required in production, HSTS, CSP, secure webhooks, SSRF/private-address blocking | config and Stage 11 gates |
| Malicious input | CSP, output encoding, no arbitrary raw EJS, IDS/IPS probe detection, malware scanning | `npm run security:check`, upload tests |
| API/Webhooks | scoped API keys, quotas, idempotency, optimistic versions, signatures, timestamp/replay/dedup controls | Stage 5/11 integration tests |
| Configuration | production fail-closed secrets/services, explicit launch countries, IDS/IPS/SIEM/MFA requirements | config tests, `npm run launch:check` |
| Supply chain | pinned lockfile, dependency audit, static secret/code scan, generated CycloneDX SBOM | `npm run security:check`, `npm audit`, `npm run security:sbom` |
| Recovery | guarded restore-test drill, PITR/rollback evidence gates | `npm run backup:drill`, `/admin/security` |
