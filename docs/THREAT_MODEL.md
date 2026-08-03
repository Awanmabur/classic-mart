# Threat model

## Assets and trust boundaries

Protected assets include credentials, sessions, identity/contact data, role and
country scope, seller documents, inventory, orders, payment events, ledger entries,
promoter attribution, delivery proof, return evidence and audit records. Trust boundaries exist at the browser,
managed WAF/reverse proxy, application, MongoDB, Redis, SMTP, malware scanner, SIEM collector and payment-provider webhooks.
The browser is always untrusted.

## Current high-priority threats and controls

| Threat | Current control | Residual action |
|---|---|---|
| Credential theft | Argon2id, secure cookies, no browser password storage, TOTP MFA/recovery for privileged accounts | Passkeys remain a future optional identity enhancement |
| Session fixation/theft | Regeneration after login, HttpOnly/SameSite cookies, device binding/revocation | HTTPS/WAF and secret rotation in deployment |
| Brute force/enumeration | Endpoint rate limits, account lockout, generic recovery, persistent security events and distributed MongoDB IDS/IPS correlation | Tune thresholds from production telemetry and WAF signals |
| CSRF | Per-session token on every unsafe method | Keep all new forms/API mutations covered |
| XSS | EJS escaping, CSP, no inline handler on server pages | Remove legacy `innerHTML` as pages migrate |
| NoSQL/operator injection | Zod allowlists, body sanitization, HPP | Fuzz every new query/filter contract |
| Broken object authorization | Middleware plus ownership filters | Add tests for every resource role/scope pair |
| Privilege escalation | Server-owned role and permission map | Admin role changes need approval workflow |
| Sensitive data exposure | Select-hidden fields, AES-256-GCM seller identifiers, authorized media routes, no-store private pages | Managed KMS rotation and retention policy at deployment |
| Malicious media | MIME allowlist, bounded decode, raster-only validation, metadata stripping, WebP re-encode, moderation and production-required ClamAV scanning | Move quarantine/scan workers to managed object storage when scale requires it |
| Catalogue ownership bypass | Store ID included in every seller object query and compound unique indexes | Continue negative object-level tests |
| Country-scope bypass | Country-admin queries and decisions are country constrained | Policy review for cross-border products |
| Inventory race/oversell | Replica-set transactions, atomic reservation predicate, idempotency key, invariant validation | Load/concurrency testing on production topology |
| Draft/wrong-country catalogue leak | Published/country/store filters are applied before public normalization; Mongo `_id` values and storage keys are never returned | Add cross-country integration tests on a production-like dataset |
| Wishlist/follow ownership bypass | Customer state is always keyed from the authenticated session; public IDs are resolved to eligible products/stores | Add high-contention mutation tests |
| Stored seller-contact abuse | Authentication, CSRF, Zod limits, body limits and a one-message-per-store/minute rule | Add distributed rate limiting before multi-instance launch |
| Mail/code abuse | Expiry, single use, attempt cap and resend delay | Provider-level delivery limits/monitoring |
| Dependency compromise | Lockfile, exact versions, automated audit, CycloneDX SBOM generation and static secret/code checks | Add signed provenance/container scanning in the deployment pipeline |
| Resource exhaustion | Body/parameter limits, rate limits, timeouts, bounded IDS/IPS caches and background SIEM delivery | Load/stress/soak test and tune production limits |
| Audit/security-log tampering | Immutable audit fields plus HMAC-protected security events verified before SIEM export | Retain restricted immutable SIEM/object-storage copies and rotate integrity keys under a managed process |


## Stage 12 security operations

- Critical reconnaissance/injection signals can create persistent temporary IPS blocks without storing raw IP addresses.
- Normal requests use bounded short-lived block/clear caches so application IDS/IPS does not add a MongoDB lookup to every request.
- Security-event integrity is verified before SIEM export; tampered events are dead-lettered and create a SEV1 incident. Exhausted SIEM delivery retries create a SEV2 operational incident.
- Privileged MFA uses encrypted TOTP secrets, one-way single-use recovery codes and atomic time-step replay prevention.
- High/critical risk acceptance and administrative MFA recovery require different authorized administrators.
- Production configuration fails closed when privileged MFA, SIEM, HTTPS, trusted-proxy settings, malware scanning or explicit launch countries are missing.

## Cross-stage abuse cases retained in regression coverage

- Public search exposes a draft, rejected or wrong-country product.
- Checkout fails to commit or release an existing stock reservation.
- Retry or forged browser redirect duplicates/marks a payment successful.
- Webhook replay creates duplicate financial events.
- Promoter self-referral, cookie stuffing or bot clicks create commission.
- Delivery proof or COD reconciliation is forged.
- Support/admin bypasses order, refund, country or approval boundaries.
- AI prompt injection exposes data or executes a sensitive action.

Each later stage must add model-specific controls and negative authorization,
replay, concurrency and audit tests before its exit gate.

## Security claim

Passing automated tests and dependency audit means no known finding was detected
by those checks at that time. It is not a guarantee of zero vulnerabilities.
Production launch still requires independent penetration testing, ASVS review,
configured WAF/monitoring, restore testing, incident ownership and remediation
of critical/high findings.


### Phone verification hardening (v2.8.2 audit)
Protected account workspaces require both server-verified email and phone. Phone verification codes are single-use server tokens; development may use the log adapter, while production requires the configured Twilio adapter. Changing the phone number clears `phoneVerifiedAt` and requires re-verification.
