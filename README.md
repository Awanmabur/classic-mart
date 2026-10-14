# Classic Mart

Current staged dashboard checkpoint: **v2.13.74 — approved role workspaces**.

Classic Mart is a server-authoritative multi-vendor marketplace built with Node.js 24, Express 5, EJS, MongoDB, Redis, Pesapal and Cloudflare R2. The approved **Unified Role Dashboard — Polished Final 19** design is connected one workspace at a time to the existing marketplace backend.

## Connected dashboards

- Customer uses `/dashboard` and canonical shopping/account routes. Seller has 17 connected `/seller/...` destinations; Promoter has 15 `/promoter/...` destinations; Finance and Support each have nine connected destinations. Moderation has eight connected `/moderation/...` destinations. Country Admin has 16 connected `/admin/...` destinations.
- Current server-side roles, staff grants and primary workspace determine login landing and access. There is no demo role selector or browser-owned business state. Seller accounts land in the Seller workspace; Finance staff grants do not render a Customer dashboard even when their stored identity role is Customer.
- Original approved base styles, scripts and images remain byte-for-byte unchanged. Live records and saved workflows use the approved layouts, with scoped additions for forms and responsive record text.
- Finance includes real refund reservation/completion, independent payout review/settlement, COD/provider reconciliation, chargeback controls, scoped reports/audit and weekly report delivery. Transfers and provider delivery are not simulated as successes.
- Support uses `/support/overview` and scoped staff pages. Customer conversations remain at `/support`. Real replies, private notes, customer appeals, receipt-backed Warehouse returns and independently completed Finance refunds use the approved layouts.
- Moderation starts at `/moderation/overview`. Product and seller verification, purchased reviews, risk cases/signals, audit, reports, independent QA and saved settings use current grants, actual source records and transactional decisions. Customer reports/replies/appeals and Seller review disputes connect to those same records.
- Country Admin starts at `/admin/overview`. Its catalogue/people, commerce, growth/content, Support, reports and settings pages use current staff grants and source-country transactions. Coupons redeem through real checkout; CMS publication requires independent approval; campaigns recheck consent at delivery; manual refunds require independent operators and actual disbursement evidence.
- Classic Wallet uses verified payment and liability accounting. Authenticated checkout debits actual funds atomically; Wallet refunds return to the same owner's wallet.
- Personal security, messages, privacy, notifications and connected apps preserve the current identity and workspace navigation. Configured MFA is required before privileged operations; enrollment retains its validated continuation.
- Pending Sellers can read all 17 connected store destinations and see how to complete verification; fulfilment and external order APIs still require an approved store. See the [hero, photo and control repairs](docs/ui/2026-10-14-repairs.md) for the latest UI checks.
- See [architecture](docs/architecture.md), [Seller contracts](docs/seller/workspace-pages.md), [Promoter contracts](docs/promoter/workspace-pages.md), [Finance contracts](docs/finance/workspace-pages.md), [Support contracts](docs/support/workspace-pages.md), [Moderation contracts](docs/moderation/workspace-pages.md) and [Country Admin contracts](docs/country-admin/workspace-pages.md) for exact routes, operations, tests and remaining production limits. Other workspaces continue through their own implementation stages.

## External-service-first development

The normal development path no longer starts a local MongoDB or rewrites `.env`.

Configure a transaction-capable Atlas database, Redis and Cloudflare R2, then run:

```bash
npm ci
npm run db:verify
npm run media:r2:check
npm run dev
```

`npm run dev` is intentionally stable:

```text
node src/server.js
```

It does not mutate MongoDB configuration or restart unexpectedly while files change. Use `npm run dev:watch` only when automatic source watching is explicitly wanted.

Use one explicit Atlas database such as `classic-mart`. Classic Mart never falls back to MongoDB's implicit `test` database for initial catalogue import.

## Initial real catalogue for Atlas + R2

For a fresh real Classic Mart database, configure an explicit database name in `MONGO_URI`, for example:

```env
NODE_ENV=development
MONGO_MODE=external
MONGO_URI=mongodb+srv://.../classic-mart?retryWrites=true&w=majority
REDIS_URL=redis://127.0.0.1:6379
MEDIA_STORAGE_DRIVER=r2
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_BUCKET=classic-mart-media
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
ADMIN_EMAIL=...
ADMIN_PHONE=...
ADMIN_PASSWORD=...
```

The initial catalogue import is intentionally explicit. Run it once with:

```bash
INITIAL_CATALOGUE_CONFIRM=SEED_REAL_CLASSIC_MART npm run db:setup
```

`db:setup` means:

```text
verify Atlas topology
        ↓
verify Cloudflare R2 write/read/delete
        ↓
import the initial real marketplace catalogue
        ↓
process and upload 3 product images per product directly to R2
```

The import creates the Super Admin foundation, countries/categories, approved brands, official Classic Mart store, Kampala warehouse, Uganda delivery/pickup basics, 12 initial products, variants, stock and 36 R2 images. These use normal catalogue identities and are accepted by production launch checks. It creates no fake promoter, demo campaign, fake reviews, fake orders or fake payment history. Re-running the import updates/upserts the same catalogue records instead of duplicating products or stock movements.

The import refuses an unspecified MongoDB database, non-external Mongo mode, non-R2 media storage, or a missing confirmation token.

## Main commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start watch mode using the configured external services |
| `npm start` | Start the web server once |
| `npm run worker` | Start the background worker |
| `npm run db:verify` | Verify MongoDB transaction topology |
| `npm run media:r2:check` | Verify real R2 write/read/delete |
| `INITIAL_CATALOGUE_CONFIRM=SEED_REAL_CLASSIC_MART npm run seed:initial` | Import/update the initial real marketplace catalogue |
| `INITIAL_CATALOGUE_CONFIRM=SEED_REAL_CLASSIC_MART npm run db:setup` | Verify Atlas + R2 and import the initial real catalogue |
| `npm run admin:reset-password -- --yes` | Reset the configured Super Admin password non-destructively |
| `npm run release:check` | Run the cumulative engineering release gates |
| `npm run release:clean-app` | Build the stripped external-service-first app package |
| `npm run release:production` | Build the production-only package |

## Media

All real uploaded marketplace media uses the object-storage boundary. With `MEDIA_STORAGE_DRIVER=r2`, product images, verification documents and operational evidence are stored in the private Cloudflare R2 bucket and delivered through Classic Mart authorization-aware media routes. Initial catalogue images use the same R2 path as real seller uploads.

## Production

Production remains fail-closed. It requires managed MongoDB, Redis, private Cloudflare R2, HTTPS, live Pesapal API 3.0 credentials, SMTP, SMS, malware scanning, production secrets, explicit launch countries and security/DR configuration. Production bootstrap creates only platform primitives and categories; production data gates block legacy development/demo markers while accepting the official initial catalogue.

Use the generated **production launch package** for Render against the same explicit real Atlas database. Follow `PRODUCTION_SETUP.md` for deployment, Pesapal IPN registration and the final launch gate.

## Security

Classic Mart includes centralized authorization/country scopes, authoritative time-bounded platform grants, MFA/four-eyes privileged controls, transaction-backed payment/refund/payout state, webhook inbox/idempotency, ledger-based finance, durable outbox processing, IDS/IPS event controls, SIEM export, W3C tracing, DR evidence gates and sanitized release packaging. These application controls complement—not replace—managed infrastructure security, independent penetration testing, payment/account review and operational launch checks.
