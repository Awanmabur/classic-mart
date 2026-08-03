# Stage 12 — Hardening, recovery and launch controls

Classic Mart Stage 12 turns the existing security baseline into an operational control plane. It does not claim that software can be vulnerability-free. Production launch still requires independent testing and real infrastructure evidence.

## Application IDS/IPS

The application security shield runs before normal application routing and records keyed hashes instead of raw client IP addresses.

Detection covers:

- secret/admin-file reconnaissance (`.env`, `.git`, `wp-admin`, phpMyAdmin and similar probes);
- path traversal;
- common XSS and SQL-injection-style probes;
- JNDI/Log4Shell-style probes;
- known automated scanner user agents;
- unsafe HTTP methods (`TRACE`, `TRACK`, `CONNECT`);
- repeated `401`, `403` and `429` responses on sensitive routes.

Critical detections are blocked immediately even if security-event persistence is temporarily unavailable. High/medium detections are correlated over a bounded ten-minute database window before a temporary block is created. A high/critical IPS block creates a correlated SEV2/SEV1 incident. Blocks persist in MongoDB using an HMAC-keyed IP hash and expire automatically. Bounded short-lived allow/block caches avoid a database lookup on every normal request. Positive cache entries are capped at 15 seconds so revocation on one application instance propagates quickly to other instances. Block-hit persistence/security-event logging is throttled per keyed IP to avoid turning an attacker into a database/log amplification source.

This is an application defence layer. It does **not** replace Cloudflare/managed WAF, network firewalling, EDR or infrastructure IDS.

## Security events and SIEM

`SecurityEvent` is separate from the normal audit trail. Each event includes request correlation, category, severity, result, country/actor context and privacy-preserving keyed network/client hashes. Both keyed IP and user-agent hashes are included in JSON/CEF SIEM exports for correlation without exporting raw client addresses.

Before persistence, the immutable event fields are signed with an independent HMAC integrity key. The SIEM worker re-verifies the HMAC before export. A modified event is moved to dead-letter state, refused export and escalated to a SEV1 incident.

Supported SIEM transports:

- HTTPS JSON;
- HTTPS CEF;
- UDP CEF/JSON for a trusted internal collector.

Delivery state is durable (`pending` → `retry` → `sent` / `dead`) with exponential backoff. Exhausted delivery retries create a correlated SEV2 operational incident; integrity failures create SEV1. Low/medium events use the normal retention window; high/critical events use a longer but finite retention window to prevent unbounded security-log growth. Production cannot run with SIEM disabled.

## MFA

Authenticator MFA uses RFC 6238-style TOTP with:

- AES-GCM encrypted authenticator secrets;
- encrypted pending-enrollment secrets;
- one-way HMAC-hashed recovery codes;
- single-use recovery codes;
- time-step replay protection stored atomically in MongoDB;
- session/device revocation after sensitive MFA changes;
- partial login sessions so a full authenticated device is created only after MFA succeeds.

When `PRIVILEGED_MFA_REQUIRED=true`, seller and operational/admin roles cannot enter protected workspaces until MFA is enrolled.

Administrative MFA recovery requires a short-lived four-eyes request. The requester and target account cannot approve the reset. Applying a reset runs the target MFA clear and device/session revocation in the same MongoDB transaction as the four-eyes recovery decision, then requires re-enrollment when the role policy requires MFA.

## Security & Launch Center

`/admin/security` provides:

- recent security-event integrity and SIEM state;
- active application IPS blocks;
- privileged MFA status and recovery requests;
- security findings and remediation evidence;
- four-eyes risk acceptance for unresolved high/critical findings;
- launch evidence for security, recovery, operations, legal, privacy, provider and controlled-pilot gates.

## Production configuration

Generate a new independent integrity secret:

```bash
openssl rand -hex 32
```

Minimum Stage 12 production settings include:

```env
NODE_ENV=production
BASE_URL=https://your-domain.example
TRUST_PROXY=1

IDS_ENABLED=true
IPS_ENABLED=true
PRIVILEGED_MFA_REQUIRED=true
SECURITY_INTEGRITY_KEY=<independent-random-secret>
SECURITY_EVENT_RETENTION_DAYS=180
SECURITY_HIGH_EVENT_RETENTION_DAYS=730

SIEM_MODE=http
SIEM_FORMAT=json
SIEM_URL=https://your-siem.example/security-events
SIEM_TOKEN=<collector-token>

LAUNCH_COUNTRIES=UG
```

`SECURITY_INTEGRITY_KEY` must differ from `SESSION_SECRET`, `TOKEN_PEPPER` and `DATA_ENCRYPTION_KEY`.

## Origin guard

An optional proxy-injected origin secret can be enabled:

```env
ORIGIN_GUARD_MODE=header
ORIGIN_GUARD_HEADER=x-classic-origin
ORIGIN_GUARD_SECRET=<strong-random-secret>
```

Use this only when the managed proxy inserts the header and the origin firewall/security group prevents direct public access. The header is an additional signal, not a substitute for firewall rules.

## Release and launch commands

```bash
npm run security:check
npm run security:sbom
npm run verify:local
npm run load:smoke
npm run backup:drill
npm run launch:check
```

`security:sbom` produces a CycloneDX 1.6 dependency inventory from the lockfile. A release SBOM is also included under `docs/SBOM_v2.13.6.cdx.json`.

`backup:drill` only writes to a database whose name ends in `restore-test`. It performs a logical critical-collection restoration/check. Provider PITR must still be proven separately and recorded in Launch Evidence.

`launch:check` requires `NODE_ENV=production` and fails while any mandatory evidence is not explicitly `passed` (including `not_applicable`), high/critical findings remain unresolved, SIEM is disabled, privileged MFA is not required, IDS/IPS is disabled or the production country rollout is unspecified.
