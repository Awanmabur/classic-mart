# Classic Mart

Current cumulative release: **v2.13.5** (Stages 1–12). — MongoDB/EJS marketplace

Classic Mart converts the supplied marketplace/dashboard UI into one server-authoritative multi-vendor marketplace while preserving the approved visual contract: rounded cards/buttons/inputs, consistent colours and spacing, standard readable type, mobile-first responsiveness, real local icons, no gradients and no redesign of supplied pages unless the blueprint has no UI for a required workflow.

Runtime: **Node.js 24 + Express 5 + EJS + transaction-capable MongoDB**. Redis is optional; when `REDIS_URL` is blank, sessions use MongoDB.

## Stage 12 status

Stages **1–11 remain the cumulative marketplace baseline** and Stage **12 adds operational hardening and launch control** without changing the approved Classic Mart UI. The source now includes persistent application IDS/IPS, HMAC-protected security events, durable SIEM export, real TOTP MFA/recovery, privileged-role MFA enforcement, four-eyes administrative recovery/risk acceptance, launch evidence, backup/load drills and fail-closed production security configuration.

The PWA/mobile/seller APIs continue to use the same server-authoritative catalogue, cart, checkout, order, payment and inventory services. Stage 12 security is an additional layer and does not pretend to replace a managed WAF, network firewall, EDR, independent penetration testing or production recovery exercises.

See `docs/STAGE_12_SECURITY_AND_LAUNCH.md`, `docs/ASVS_SELF_REVIEW.md`, `docs/ops/cloudflare/README.md`, `docs/STAGE_11_GATE_MATRIX.md`, `docs/MOBILE_PWA_READINESS.md`, `docs/STAGE_10_GATE_MATRIX.md`, `docs/STAGE_9_GATE_MATRIX.md`, `docs/STAGE_1_8_AUDIT.md` and `docs/STAGES.md`.


## v2.13.5 commerce functionality

The product preview is now variant-aware and quantity-aware. Price, compare-at price, discount, stock, SKU and line total update immediately when the shopper changes option or quantity. Add to Cart stays on the preview; Buy Now waits for the server cart write before navigating. The browser cart is keyed by variant, so multiple options of the same product remain separate lines.

The release gate includes both `frontend:audit` and `functionality:audit`, followed by automated tests and the real MongoDB Stage 1–12 integration audit. Product cards expose aggregate stock across all active variants, while preview, web cart and mobile cart expose and enforce stock for the exact selected variant.

## Requirements

- Node.js 24.x and npm.
- Windows local development does not require Docker or Atlas. Classic Mart can run its isolated MongoDB Community Server replica set on `127.0.0.1:27018` and persist it under `.classic-mart/`.
- macOS/Linux: install MongoDB Community Server (`mongod` on PATH) or configure a transaction-capable `MONGO_URI`.
- Redis is optional.
- SMTP, Twilio, ClamAV and Flutterwave credentials are required only for their corresponding production/online features.

## Install / upgrade

Keep the existing `.env` and `.classic-mart/` when upgrading normally. For an intentional completely fresh local start, install dependencies and run the guarded reset command first.

```bash
npm ci
# Optional destructive local reset: removes only .env and .classic-mart/ after safely stopping Classic Mart MongoDB.
npm run reset:local -- --yes
npm run verify:local
npm run dev
```

The reset regenerates `.env` from `.env.example` with fresh random local secrets and prints the new local Super Admin password. Do not use the reset command when you need to keep existing local users/orders/products.

Local development defaults to `MONGO_MODE=local`. In that mode Classic Mart uses the project `.env` MongoDB settings and ignores inherited/system `MONGO_URI` values. To intentionally use Atlas or another external development MongoDB, set `MONGO_MODE=external` and provide `MONGO_URI`. Production remains environment-driven and fail-closed.

Open `http://localhost:3000` after `Classic Mart ready`.

### Four-eyes reviewer

High-risk Stage 9 changes cannot be approved by the administrator who requested them. Configure a second real Super Admin reviewer if your operating team needs global approvals:

```env
ADMIN_REVIEWER_NAME=Approval Reviewer
ADMIN_REVIEWER_EMAIL=reviewer@example.com
ADMIN_REVIEWER_PHONE=+2567XXXXXXXX
ADMIN_REVIEWER_PASSWORD=use-a-strong-unique-password
```

Leave all reviewer fields blank to skip reviewer bootstrap. Classic Mart never creates a known/default reviewer password.

## Local database commands

| Command | Purpose |
|---|---|
| `npm run db:local` | Ensure the Classic Mart-owned transaction-capable local MongoDB is running |
| `npm run db:local:stop` | Stop only the Classic Mart-owned local MongoDB and keep its data |
| `npm run reset:local -- --yes` | Destructively reset local `.env` and `.classic-mart/`, regenerate local secrets and start from a blank database on next setup |
| `npm run db:verify` | Verify the configured MongoDB supports transactions |
| `npm run db:setup` | Ensure DB, verify topology and seed reference/admin/configuration data |
| `npm run verify:local` | Full local seed + cumulative Stage 1–12 release gate |
| `npm run dev` | Ensure local DB and start watch mode |
| `npm run security:check` | Static security/source gate |
| `npm run frontend:audit` | Verify visible operational data and major frontend/database wiring |
| `npm run functionality:audit` | Verify preview, variant, cart, catalogue and wishlist interaction contracts |
| `npm run security:sbom` | Generate CycloneDX dependency SBOM |
| `npm run load:smoke` | HTTP p95/error-rate smoke load gate |
| `npm run backup:drill` | Guarded logical restore drill to a `*-restore-test` database |
| `npm run launch:check` | Verify production config, launch evidence and unresolved high/critical findings |

## Release gate

`npm run verify:local` performs:

```text
transaction-capable MongoDB
        ↓
seed reference/admin/CMS/feature data
        ↓
release-script preflight + import/export integrity + source + syntax + EJS + security + visual checks
        ↓
automated tests
        ↓
transaction verification
        ↓
real Stage 1–12 integration audit in guarded *-audit-test database
        ↓
npm audit --audit-level=high
```

Stage 12 launch remains blocked until required external evidence (penetration test, restore/PITR, WAF/SIEM monitoring, incident exercise, controlled pilot and legal/privacy/payment/tax review) is recorded and `npm run launch:check` passes.


## Stage 12 production hardening

Generate `SECURITY_INTEGRITY_KEY` independently from every other secret and enable privileged MFA, IDS/IPS and a real SIEM collector in production. Production also requires HTTPS, a trusted reverse-proxy topology, malware scanning and explicit `LAUNCH_COUNTRIES`. See `.env.example` and `docs/STAGE_12_SECURITY_AND_LAUNCH.md`.

The Security & Launch Center is available to authorized administrators at `/admin/security`.

## Classic AI configuration

Classic AI is safe-by-default. External generation is disabled until you explicitly configure a provider. The local embedding/retrieval path still supports hybrid search and grounded fallback.

```env
AI_PROVIDER=disabled
AI_API_KEY=
AI_CHAT_MODEL=
AI_EMBEDDING_MODEL=
```

Provider/model changes stored in the model registry are four-eyes controlled; API keys remain environment-only and are never stored in MongoDB.

## Production boundaries

Production must explicitly configure transaction-capable `MONGO_URI`, independent secrets, SMTP, Twilio SMS and an upload malware scanner. Automatic local MongoDB bootstrap is disabled in production. Hosted Flutterwave checkout keeps card credentials outside Classic Mart and browser redirects never prove payment.

No software can honestly be guaranteed vulnerability-free. Classic Mart targets defence in depth and continuous release verification; independent penetration testing, backup/recovery validation and production infrastructure review remain launch requirements.
