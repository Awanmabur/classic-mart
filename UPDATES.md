- 2026-08-02: Fixed `verify:local` browser-authoritative persistence failure by replacing visual-search `sessionStorage` transfer with one-time server-session transfer.
## v2.13.5 — Mobile variant authority and Stage 11 integration repair

- Corrected the real MongoDB Stage 11 audit to compare mobile cart price, stock and SKU with the exact selected published variant.
- Kept product-level stock as the aggregate across active variants and now verifies that invariant separately.
- Added regression protection against comparing variant cart availability with aggregate product stock.
- Preserved all v2.13.4 preview, cart, checkout and platform interaction fixes.

# Classic Mart updates
## 2026-08-02 — v2.13.5 product preview and commerce functionality repair

- Product preview now recalculates total price as quantity changes.
- Variant selection updates price, compare-at price, discount, stock, SKU, option label and WhatsApp context.
- Add to Cart and Buy Now persist the selected variant and quantity before reporting success or navigating.
- Browser cart lines now use variant IDs so multiple variants of one product remain separate.
- Final cart-item removal and cart clearing now render the empty state correctly.
- Server cart additions reject insufficient stock instead of silently clamping quantity.
- Catalogue and wishlist cart mutations now await persistence; wishlist bulk add is sequential.
- Added `functionality:audit`, commerce regression tests and real MongoDB multi-variant integration assertions.


## 2026-08-02 — v2.13.3 profile route contract correction

- Corrected the public-page test matrix to treat `/promoters/profile` as a permanent alias instead of a direct page.
- Preserved seller slugs and promoter IDs across query-based and legacy `.html` profile links.
- Added direct dynamic profile route coverage and dependency-free regression tests.
- Preserved the v2.13.2 MongoDB-backed frontend data/functionality implementation.

## 2026-07-31 — v2.13.1 role-dashboard and workflow QA

- Added the missing shared responsive styling for operational workspaces and seller fulfilment tables/actions.
- Added shared locale-aware money rendering across major finance/business/promoter views.
- Restricted seller campaign products to published products owned by the verified store and replaced raw product-ID entry with database-backed selection.
- Replaced normal Business Buyer raw product/store ID entry with eligible MongoDB-backed product and seller choices.
- Added regression coverage for operational responsive layout and the seller/business workflow boundaries.
- Preserved the fully verified Stage 1–12 backend and v2.13.0 PWA/location/category QA fixes.

## v2.13.0 — post-verification storefront/PWA QA

- Fixed PWA install surfaces, delivery-location deep links and database-driven homepage category controls.
- Added final UI/PWA regression coverage and release-gate assertions.
- Preserves the fully verified v2.12.12 Stage 1–12 backend baseline.

## v2.12.12 — Stage 10 evaluation and Stage 11 webhook audit fixes

- Fixed provider-disabled AI evaluation run validation by recording truthful local evaluation provenance.
- Fixed webhook test API numeric queued-count handling.
- Added Stage 10/11/12 checkpoints to the real integration audit.
- Added regression tests for both issues.

## v2.12.11 — deterministic fresh local MongoDB configuration

- Fixed the shared `.env` parser so blank values such as `MONGO_URI=` and `AUDIT_MONGO_URI=` cannot consume the following line.
- Added explicit `MONGO_MODE=local|external`; local is the default and external development MongoDB requires opt-in.
- Local mode ignores inherited/system-level MongoDB URI values and prefers project `.env` database settings.
- Centralized MongoDB resolution across app config, verification, integration audit, backup drill and local stop/reset tooling.
- Added isolated integration-audit test override so ordinary tests cannot accidentally connect to an inherited MongoDB URI.
- Added regression coverage for blank env values, inherited Windows variables, test isolation and external opt-in.

## v2.12.10 — full verification hardening

- Fixed Mongoose-subdocument budget cancellation math and added behavioral regression coverage.
- Added import/export integrity checking to the release gate.
- Removed IDS/IPS database-buffering delays when the security database is unavailable while retaining critical fail-safe blocking.
- Strengthened integration assertions for exact business-budget commitment lifecycle.
- Removed the unused external CDN preconnect and re-ran cumulative static/security/hygiene checks.

## v2.12.7 — settlement invariant and release-check correction

- Fixed the verified-payment service import for the shared `sellerSettlementBreakdown` helper introduced by the COD reconciliation hardening.
- Replaced the obsolete release-check assertion that searched for direct `sellerOrder.discountMinor` usage with checks for the shared discount-aware settlement invariant.
- Strengthened Stage 5 and seller-growth regression tests so both verified provider payments and COD must import and use the same settlement calculation.
- Preserves the v2.12.6 transactional COD reconciliation and diagnostic reconciliation-run behavior.

## v2.12.6 — COD reconciliation release-gate correction

- Reworked COD reconciliation to reload shipment, order and payment intent inside one MongoDB transaction.
- Unified card/mobile and COD seller settlement math through `sellerSettlementBreakdown`, including seller-funded discounts and platform fees.
- Added payment amount/currency consistency checks before COD ledger posting.
- Batch reconciliation now preserves a safe failure code and reconciliation-run ID for diagnosis.
- Added regression coverage for transactional COD reconciliation and shared settlement accounting.

# v2.11.1

- Migrated all 53 server-rendered views from `.html` filenames to native `.ejs` templates.
- Express now uses `view engine = ejs`; route handlers render extensionless view names.
- Converted live navigation from `.html` filenames to clean Express routes while preserving 301 legacy redirects for old bookmarks.
- Made bundled CSS/JS/icon paths root-relative so nested routes cannot break assets.
- Added the missing Developer Portal / Connected Apps role-workspace stylesheet and fixed the stale `/style.css` reference in Ask Classic.
- Removed customer-facing Stage 9/10/11 implementation labels and replaced obsolete planned-app messaging with the live installable PWA.
- Added a view-system regression suite covering template extensions, render targets, clean navigation and local asset existence.

# v2.11.0

- Stage 11 PWA/mobile/external API implementation.
- Fixed seeded storefront images with bundled local product assets and removed remote Unsplash runtime dependency.
- Added mobile token rotation/reuse revocation, push/deep links, scoped seller API clients, idempotency/concurrency controls, signed DNS-pinned webhooks, OpenAPI and Developer Portal.
- Added Stage 11 readiness and Stage 1–11 integration release gates.

# Classic Mart updates

## 2026-07-31 — v2.10.0 Stage 10 Classic AI + cross-section completion

- Added provider-neutral Classic AI gateway/model registry with environment-only secrets and four-eyes model-registry changes.
- Added versioned prompts, structured schemas, moderation, prompt-injection blocking, bounded/minimized context, quotas, daily cost budgets and detailed usage/failure telemetry.
- Added asynchronous seller product-draft/category/attribute/translation/image-quality jobs with mandatory seller confirmation.
- Added MongoDB embeddings, hybrid semantic search, similar products and recommendation explanations with country/stock/seller/moderation hard filters.
- Added Ask Classic, in-memory visual search and explicit server-revalidated AI cart drafts; disabled-provider mode uses honest grounded retrieval fallback.
- Added seller, support and promoter assistants with human/campaign approval boundaries; AI has no refund/payout/ledger/enforcement authority.
- Added persisted evaluations/feedback and seeded prompt-injection/hard-filter red-team cases plus Stage 10 observability.
- Closed previously tracked cross-section gaps: business organizations/team/budgets/approvals/quotes/POs/recurring procurement/statements and Seller Growth vouchers/bundles/quantity breaks/free shipping/sponsored disclosure/minimum/scheduled pricing/consent broadcasts.
- Seller-funded promotions are recomputed by checkout and preserved through seller settlement and return/refund calculations.
- Notification outbox now executes consent-approved campaigns/broadcasts; development log mode records a truthful non-delivery sink.
- Extended the real MongoDB audit and release checker through Stage 10.

## 2026-07-31 — v2.9.0 Stage 9 admin, CMS, analytics and growth

- Added Country/Super Admin attention centres with real country-scoped operational queues.
- Added four-eyes approval for country/payment/delivery settings, feature rollout, CMS publish/rollback, gift-card issuance, exports and impersonation.
- Added server-evaluated feature flags by country, role, schedule and deterministic rollout percentage.
- Added versioned/scheduled/reversible CMS connected to home/help/legal content.
- Added loyalty, referrals, encrypted gift cards and consent-aware scheduled campaigns.
- Added operational/finance/search/seller/promoter reporting, privacy exports, incidents and platform health.
- Added read-only, visible, audited, single-use/30-minute impersonation.
- Added optional second Super Admin reviewer bootstrap without any default reviewer credential.
- Extended the real MongoDB audit and release checker through Stage 9.

## 2026-07-31 — v2.8.13 managed local MongoDB lifecycle recovery

- Fixed the saved-local-URI restart bug: `db:local`, `verify:local` and `dev` now restart Classic Mart's `classicmart-rs` automatically when its saved local URI exists but the process is currently down.
- Preserves and reuses `.classic-mart/mongodb`; no database reset is performed during restart.
- Recognizes managed local URIs across `127.0.0.1`, `localhost` and IPv6 loopback by replica-set/database identity rather than a brittle prefix check.
- Recovers duplicate/stale `MONGO_URI=` lines left by earlier upgrades and rewrites `MONGO_URI` plus `CLASSIC_MART_MONGO_PORT` as one canonical assignment each.
- External/Atlas MongoDB remains fail-closed when unreachable, and production still forbids automatic local MongoDB startup/installation.
- Added lifecycle unit/regression coverage so stop → later restart and duplicate-environment recovery cannot silently regress.

## 2026-07-31 — v2.8.7 self-bootstrapping local MongoDB

- Removed the remaining requirement to manually provide `MONGO_URI` for local Windows development.
- Added `npm run db:local`, which finds/installs MongoDB Community Server when necessary, runs an isolated `classicmart-rs` replica set on port 27018, persists data under `.classic-mart/`, and writes only the generated local `MONGO_URI` to `.env`.
- `npm run dev`, `db:setup`, and `verify:local` now ensure local transaction-capable MongoDB automatically.
- Added `npm run db:local:stop`; data is preserved.
- Production remains explicit and fail-closed: no automatic database installation/bootstrap when `NODE_ENV=production`.

## 2026-07-31 — v2.8.6 Docker-independent infrastructure

- Removed Docker/Compose from the required development, seed, test and release workflow.
- MongoDB is now configured only through explicit `MONGO_URI`; no implicit localhost fallback remains.
- Added `npm run db:verify`, which validates replica-set/mongos transaction support without changing database topology.
- `AUDIT_MONGO_URI` is optional; the Stage 1–8 integration audit safely derives `classic-mart-audit-test` from the application cluster when blank.
- Redis is optional; blank `REDIS_URL` uses MongoDB-backed sessions in development or production.
- Removed local MongoDB Compose/bootstrap files from the release package. The `Dockerfile` remains only for optional application container deployment.
- `npm run verify:local` is now the single Docker-free seed + Stage 1–8 release gate after `npm ci`.

Earlier Stage 1–10 fixes remain included. `docs/STAGE_1_8_AUDIT.md`, `docs/STAGE_9_GATE_MATRIX.md` and `docs/STAGE_10_GATE_MATRIX.md` preserve the cumulative verification record; `RELEASE_NOTES_v2.13.5.md` is the current release record; prior release history is consolidated in this file.

## v2.8.13 storefront visibility repair
- Fixed an undeclared browser `state` object that prevented the homepage catalogue sections from rendering.
- The homepage now receives a MongoDB-backed initial catalogue payload in the first server response and refreshes it from the storefront API.
- Added a storefront runtime regression test so the blank-page bug is caught by the release suite.


## v2.12.4

- Fixed the Windows path-separator false positive in `security:check`.
- Added cross-platform regression coverage for the security checker self-exclusion.
- Kept `eval()` and `new Function()` blocked everywhere except the scanner source that necessarily contains the detector expressions.
- Updated package, SIEM/CEF and SBOM release identifiers.

## v2.12.3

- Corrected release packaging so `.env.example` is included in the distributed ZIP.
- Updated package/SIEM/SBOM release identifiers.
- Preserved v2.12.2 TTL migration and all Stage 12 hardening.
