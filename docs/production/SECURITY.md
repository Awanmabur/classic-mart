# Security Architecture and Operating Rules

## Identity
Passwords use Argon2. Email and phone verification are separate controls. Privileged roles require MFA in production. Session/token versions are incremented when staff access changes or an account is anonymized/suspended so prior sessions cannot remain valid.

## Authorization
`shoppingCountry` is a customer preference. It is never used as an employee authorization grant. Platform employees receive hidden server-controlled `operationalCountries`; Super Admin uses global scope. Resource policies derive scope from these grants, store/business membership and capabilities.

Privileged staff access follows:
```text
verified account -> MFA -> access request -> different approver -> role/country grant -> session revocation -> audit
```
Country Admin cannot grant Finance, Country Admin or Super Admin authority.

## Four-eyes operations
High-risk operations—including privileged staffing, payout lifecycle, impersonation and chargeback resolution—require distinct actors where configured by the workflow. Read-only impersonation is time-bound, one-use approved and blocks mutations.

## Web security
- Helmet/CSP and HSTS in production.
- CSRF for authenticated mutations; provider webhook endpoints are deliberately exempt and independently verified.
- body/query sanitization and explicit schema validation.
- rate limiting and security event capture.
- origin guard, IDS/IPS controls and SIEM export in production.
- uploads are decoded/re-encoded and production requires malware scanning.

## Sensitive data
Sensitive stored values use AES-256-GCM through `core/sensitive.js`. Delivery/pickup OTP verifiers use HMAC-SHA256 with the independent security integrity key, include attempt lockout and clear encrypted OTP material after use.

## Financial security
- immutable double-entry ledger;
- immutable payment/refund documents;
- idempotency keys and unique database constraints;
- atomic refund reservations;
- external payout ambiguity is represented explicitly rather than retried blindly;
- provider callbacks are independently verified.

## Release security
Never deploy the developer directory. `npm run release:build` uses an allowlist and excludes `.env`, `.git`, `node_modules`, `.classic-mart`, runtime storage, logs, old `dist` and artifacts. CI runs static security checks, dependency audit, SBOM and builds the sanitized archive.

Rotate any secret that was ever included in an exported ZIP or shared outside the trusted environment.
