## v2.13.64

- Rebuilt Dashboard #8 (Moderator) on top of the verified v2.13.63 Finance checkpoint.
- Added all 8 approved Moderator pages with server-side role routing and no manual workspace selector.
- Bound Moderator queues to real country-scoped product, review, seller-verification, trust-case, risk-signal, QA and audit data.
- Added immutable audit evidence for review moderation, trust-case enforcement and risk-signal review across Moderator and legacy Support trust workflows.
- Enforced independent-review four-eyes protection for appealed trust cases.
- Preserved Customer, Seller, Promoter, Business Buyer, Support, Warehouse/Logistics and Finance dashboards unchanged.

## v2.13.58

- Rebuilt Dashboard #2 (Seller) independently after the v2.13.57 Customer checkpoint.
- Preserved all 17 approved Seller pages with no manual role/workspace selector.
- Bound Seller pages to real store-scoped catalogue, inventory, orders, fulfilment, returns, customers, growth, finance, reviews, messages and subscription data.
- Added a dependency-free least-privilege Seller dashboard data plan so unauthorized staff roles do not query sensitive collections.
- Reused the live SellerPromotion voucher engine for Seller Coupons and existing payout/finance services for money workflows.
- Fixed Seller return-state values and safe dashboard-return behavior for dashboard-originated mutations.
- Kept the v2.13.57 Customer dashboard unchanged; all other role dashboards remain pending their own checkpoint.

## v2.13.51

- Centralized the customer-facing marketplace header and footer into shared EJS partials.
- Aligned Classic AI and the installable-app page with the same storefront shell.
- Changed direct sign-in fallback from `/dashboard` to `/` while retaining safe protected-route return navigation.
- Added v2.13.51 regression coverage for shell reuse, Classic AI layout, request-path locals and login return behavior.
- Kept v2.13.50 performance, cache, database and media hardening cumulative and unchanged.

## v2.13.50

- Re-aligned Classic AI public and operations UI with the main Classic Mart design system.
- Reduced oversized product imagery across Trending, catalogue, related, recommendation and wishlist cards.
- Hid the native Shop by Category scrollbar without removing swipe/arrow navigation.
- Replaced dead footer social symbols with optional validated HTTPS social links configured through environment variables.
- Parallelized homepage, authentication and post-login work; made dashboard data loading section-specific.
- Added short-lived feature/sponsored caches and stale-while-revalidate storefront/public-asset caching.
- Added compound indexes for dashboard queue access patterns.
- Made `npm run dev` stable and moved automatic restart behavior to `npm run dev:watch`.
- Prevented private/no-store catalogue media from entering the public service-worker cache.


## v2.13.49

- One explicit real Atlas database is now supported for initial catalogue import.
- Replaced starter-only seed naming with production-style initial catalogue identities.
- Added explicit one-time real-seed confirmation and kept Atlas/R2 fail-closed checks.
- Production launch checks accept the official initial catalogue while still blocking legacy demo/seed records.
# v2.13.47

- Added private Cloudflare R2 production media storage with SigV4 authentication and no new third-party SDK dependency.
- Routed product images, verification documents and operational evidence through object storage.
- Preserved application authorization for private documents and published-media cache policy.
- Updated visual search and image-quality analysis for R2-backed media.
- Added fail-closed R2 production configuration and `media:r2:check` readiness probe.
- Local development remains filesystem-backed.

# v2.13.42

- Fixed Mongoose 9 `PlatformGrant` seed validation (`next is not a function`) using throw-based middleware semantics.
- Confirmed no other callback-style model middleware remains.
- Rebuilt product-preview Buying details as exactly two cards: Delivery & payment, and Listing & seller.
- Preserves every cumulative v2.13.41 database, dependency, media, storefront, finance and release-hardening change.

# v2.13.41

# Classic Mart v2.13.41 — Upgrade index repair and dependency security

- Replaced the partial hand-maintained TTL-repair list with automatic discovery of every single-field TTL index declared by registered Mongoose models.
- When `collMod` cannot convert a legacy normal expiry index, `db:setup` now drops only the safe legacy single-field index and immediately recreates the required TTL index before continuing.
- Index creation now runs model-by-model and reports the exact model on failure; seed errors use Pino `err` serialization so stack/message/code are retained instead of logging `{}`.
- Upgraded `sharp` to 0.35.4 and pinned transitive `qs` to 6.16.0.
- Preserves the v2.13.40 3–5 image, optional product-video, richer product-preview, real review-distribution and stale-local-cache fixes.

# v2.13.40

# Classic Mart v2.13.40 — Runtime, media and product-detail hardening

- Fixed `SupportTicketPresence.expiresAt` duplicate plain/TTL index declaration and added safe TTL index reconciliation during `db:setup`, resolving MongoDB `IndexOptionsConflict` code 85 without deleting marketplace data.
- Reworked the PWA service worker to network-first freshness for CSS/JS/assets/catalogue media, disabled service-worker script caching during registration, and reduced mutable public-media cache TTL so removed UI and reseeded images do not require Ctrl+F5.
- Added a real `/favicon.ico` asset.
- Enforced 3–5 product images for seller submission, with a hard maximum of five active images.
- Expanded each of the 12 development reference products to three distinct product photographs (36 seed images total), while retaining secure HTTPS/host/content-type/size/atomic-write validation and offline fallback.
- Added one optional product video URL per product, restricted to HTTPS YouTube/Vimeo links.
- Enriched the product preview with rating/review/sold context near the title, promoter earning, listing date, optional video, barcode, complete seller-provided attributes, explicit delivery/return/warranty information, and clearer specifications.
- Preserved existing marketplace data during upgrade; seed remains idempotent.

# v2.13.38

- Every storefront product now receives the dynamic country promoter commission rate (default 3%).
- `Prom 3%` is rendered at the bottom-right of every homepage product image and follows approved country settings instead of static card text.
- Marketplace promoter commission is real accounting logic, with self-store exclusion and attribution-time rate snapshots.
- Cards keep only the live price; compare-at pricing remains preview/detail-only; review metadata stays beside the current price.
- Top Brands now wraps the full live brand set.
- Added a root-level upgrade overlay package to prevent nested-folder upgrades from leaving the running project unchanged.

# v2.13.37

- Product-card compare-at prices removed; preview/detail remains authoritative for struck-through old prices.
- Ratings/reviews moved beside current price.
- Top Brands now derives from full published-country brand counts and live initial data.

# v2.13.36

- Repaired public catalogue runtime crash (`sellerPage is not defined`).
- Restored homepage/products/categories/search catalogue loading.
- Added non-destructive Super Admin password recovery and session revocation.
- Fresh development bootstrap now generates/prints a strong one-time Super Admin password; production requires an explicit strong password.
- Added permanent storefront/admin-recovery regression contracts.

# Classic Mart updates

## 2026-09-08 — v2.13.8 maintenance progression and AI worker hardening

- Added persistent full-history scan progression for product alerts and stale embedding discovery.
- Prevented meaningless in-stock restock alerts and cursor-paginated alert history.
- Made embedding freshness source/country/current-model aware.
- Added reclaimable AI worker leases and explicit exhausted-claim failure handling.
- Made setup create indexes for every exported model after TTL reconciliation.
- Moved 90-day demand-forecast aggregation into MongoDB.

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

## 2026-08-03 — v2.13.6 approved UI preservation hotfix

- Product cards now expose live promoter campaign percentages from MongoDB campaign `commissionBps`; no client-side 3% constant or static commission calculation remains.
- Promoter and category badges keep their approved bottom-right and bottom-left phone positions.
- Dynamic Top Brands rendering preserves the approved wordmark treatment and front-layer visibility.
- Phone section swipe arrows remain beside section actions instead of being replaced by controls below the rows.
- Image and voice search icons use distinct colours with transparent backgrounds and the existing search dimensions.
- Product preview retains variants, reviews, questions, alerts, cart and buy-now behaviour while using the approved labels and one quantity-adjusted price.
- Dashboard branding, header spacing and phone KPI composition were corrected without replacing live server data or permission checks.
- Added UI-preservation regression coverage and bumped the public cache to `classic-mart-public-v18`.

## v2.13.11 — Support operations hardening

- Added durable support queues with legacy production backfill and migration certification.
- Added queue/search/assignment/SLA filtering, transfer history, collision presence, reopen and transactional merge workflows.
- Added country-scoped saved replies and richer one-screen support context.

## v2.13.12 — Moderator operations hardening

- Added atomic moderator ownership and release for product and seller-verification queues.
- Added durable escalation state/history and queue filters for assignment, risk and second-review work.
- Restricted-category product approval now requires a different second reviewer before final approval.
- Added scoped server-owned reason templates plus independent, country-scoped moderation QA sampling.
- QA preserves original reviewer/decision/reason and prevents reviewers from quality-checking their own decisions.
- Production migration backfills submitted restricted-product risk/four-eyes state and certifies the invariant.

## v2.13.13 — Finance control-centre hardening

- Added immutable PaymentIntent country snapshots with production migration/certification for legacy payment attempts.
- Added country-safe payment/refund/payout/chargeback/provider-event/reconciliation filtering and preserved cursor filters.
- Added finance exception visibility for provider failures, UNKNOWN payouts, reconciliation failures, stale refunds, open chargebacks and pending COD.
- Added a Finance-native delivered-COD reconciliation queue using the existing transactional ledger reconciliation path.
- Added calculated ledger-account balances and a country-scoped, CSV-formula-safe ledger export with audit logging.


## v2.13.17 — Immutable B2B commercial documents

- Added immutable revisioned quotation, purchase-order, tax-invoice and delivery-note snapshots with SHA-256 integrity digests.
- Seller quotation revisions, PO issue, invoice issue and delivery-note issue now occur inside their authoritative commerce transactions.
- Added organization-authorized company document history and downloadable PDFs.
- Added legacy-safe document backfill/certification without fabricating historical quotation revisions.

## v2.13.18 — Seller return operations hardening

- Added immutable seller-return SLA and exact seller/platform financial-impact snapshots aligned with Finance refund allocation.
- Added seller return search/status/overdue filters with cursor pagination.
- Added return shipment, customer reason/resolution, warehouse inspection/disposition and privacy-controlled evidence context.
- Added production migration/certification for legacy seller-return operational snapshots.

## v2.13.19 — Seller finance scope and settlement control

- Active-store-safe seller Money workspace and strict store-level payout ownership.
- Legacy payout store-scope migration with ambiguity certification.
- Canonical seller-payable ledger statement, exact refund/order economics and payout reconciliation visibility.
- Audited streamed CSV settlement export.
- 22/22 cumulative hardening contracts and all offline source/security/frontend gates passing.


## v2.13.20 — Seller SKU profitability and inventory aging/replenishment

- Frozen historical SKU cost snapshots for new consumer/B2B orders; legacy missing cost is explicit `legacy_unknown`, never current-cost backfill.
- Refund allocations retain exact SKU/cost snapshot identity for profitability reconciliation.
- Added seller SKU contribution reporting with explicit legacy coverage and completed refund reversals.
- Seller stock queue is cursor-paginated with SKU/state/inactivity filters, replenishment status and clearly-labelled recorded operational age.
- 23/23 cumulative hardening contracts and all offline source/security/frontend gates passing before release packaging.

## v2.13.21 — corrected Seller operations and explicit seller shipments
- Supersedes v2.13.20 after independent review found a Seller inventory-aging JavaScript syntax error.
- Corrected the inventory aggregation syntax and re-ran cumulative source gates.
- Seller orders now expose and enforce explicit SellerShipment identity separate from the root customer delivery.
- Legacy seller-shipment links are migration-certified and never guessed when root shipment/parcel evidence is incomplete.

## v2.13.22 — Promoter lifecycle and reconciliation control

- Added explicit Estimated → Payable → Paid promoter lifecycle visibility and separated reversed/adjusted commission.
- Added blocked attribution/fraud-hold, pending appeal, submitted payout and UNKNOWN payout visibility.
- Added campaign-level conversion funnel reporting and exact commission reconciliation history.
- Added audited, streamed, spreadsheet-formula-safe promoter commission CSV export.
- Added release contracts protecting refund/chargeback reversal reasons and Promoter payout ambiguity handling.

## v2.13.23 — Real-browser and WCAG release gate

- Added deterministic Playwright + axe dependencies and lock entries.
- Added desktop/mobile Chromium critical-flow tests and WCAG A/AA accessibility checks.
- CI now seeds deterministic browser fixtures, installs Chromium, runs browser/a11y gates and preserves traces/screenshots/videos/reports on failure.
- Canonical `release:check` now includes the browser gate.
- Sanitized source releases must include the browser harness.
- Local source contracts/gates pass; actual browser execution remains mandatory in Node 24 CI before production GO.

## v2.13.24 — Browser/A11y + measurable DR gate
- Added a Node 24 Playwright/Chromium + axe WCAG release gate and ensured the sanitized source release contains its test harness.
- Added explicit production RPO/RTO/evidence-freshness policy, measured expiring recovery evidence and launch-check enforcement.
- Upgraded the logical restore drill to bounded streaming, index recreation/verification and protected structured evidence; logical restore cannot be represented as PITR proof.
- Expanded the DR runbook/checklist to require replacement-environment recovery of authoritative business/finance/queue state and required media/config/key scope.
- Offline gates: 34/34 contracts, 291 JS import/export, 327-file security, 60-view frontend/functionality PASS.
- Production remains NO-GO until real Node 24 Chromium/axe, Mongo/Redis, Docker, provider recovery and live Pesapal gates pass.

## v2.13.25 — Authoritative platform grants

- Migrated platform staff privilege from `User.role` authority to one expiring authoritative `PlatformGrant`.
- Added clean-install and production-upgrade grant provisioning/certification.
- Added grant lifetime and warehouse scopes to four-eyes staff provisioning.
- Enforced warehouse-scoped access in logistics operations.
- Updated Staff & Access to display authoritative grant state instead of legacy role mirrors.

## v2.13.26 — Durable W3C transaction tracing

- Added W3C `traceparent` + async-local trace/span context at HTTP boundaries.
- Persisted immutable trace correlation on orders, payment intents, provider events, ledger transactions, shipments and outbox events.
- Payment/provider calls reconnect to the originating order trace and Pesapal receives trace headers.
- Provider-event and notification workers restore persisted trace context across retries/restarts.
- Finance can search payment/provider queues by trace ID; ledger export includes `trace_id`; historical untraced records are labelled `legacy unavailable` rather than backfilled.
- Offline contracts increased to 46/46 passing before version packaging.

## v2.13.27 — Customer partial fulfilment/refund visibility

- Customer tracking now shows independent lifecycle dimensions instead of legacy order status alone.
- Added per-line delivered/returned/refunded quantity progress.
- Added explicit SellerShipment/parcel progress for multi-seller orders while retaining the root consolidated delivery.
- Added immutable financial-document history links for receipts/credit notes/other issued order documents.
- Customer dashboard order history now renders payment/fulfilment/refund state with existing cursor pagination.

## v2.13.28
- Closed remaining silent fixed-limit history gaps in Staff & Access and the B2B document register.
- Added independent cursor pagination/totals for platform grants, staff invitations, commercial documents and financial documents.
- Replaced the first-200 support-transfer selector with server-side authorized-operator search.
- Added permanent regression/release-preflight contracts for operational-history pagination.

## v2.13.29 — Atomic refund counters and concurrency certification

- Added authoritative `PaymentIntent.refundReservedMinor` and `refundedMinor` counters.
- Refund reservation/completion/failure now atomically maintains captured-payment refund capacity.
- Added migration/backfill/certification for refund-counter drift.
- Expanded the Mongo concurrency audit to prove refund reserve/complete and warehouse claim races in addition to payment/shipment/return/recurring-procurement invariants.

## v2.13.30 — Shared operational UI and phone-first queues

- Centralized Admin, Business, Support, AI and Logistics operational presentation into reusable shared CSS rather than page-specific inline style blocks.
- Added an explicit shared operations UI enhancer that derives mobile labels from table headers.
- Operational tables now become readable phone cards instead of compressed/horizontally-scrolled desktop tables, including Seller and AI workspaces.
- Added permanent Stage 13 and release-preflight contracts protecting shared operational presentation and mobile queue behavior.

## v2.13.31 — Browser accessibility behavior gate

- Expanded browser accessibility beyond axe to 400%-equivalent reflow, reduced motion, visible keyboard focus and WCAG 2.2 minimum mobile target sizes.
- Added authenticated mobile operational-table verification for labelled card rendering and no page-level horizontal overflow.
- Added final-cascade reduced-motion overrides to the shared/public/operational stylesheet layers.

## v2.13.32 — Transactional administrative decisions

- Moved product-moderation and seller-verification audit evidence inside their authoritative Mongo transactions.
- Transactional audit failure now aborts high-risk decisions instead of silently leaving unaudited state.
- Made high-risk ApprovalRequest application one-time and atomic by rechecking `requested` inside the transaction and committing target mutation + `applied` state together.
- Made PlatformGrant/User compatibility writes session-aware for staff-access approval.
- Kept export-file generation post-commit because filesystem side effects are not transactionally rollbackable with MongoDB.
- Added permanent Stage 13 and release-preflight contracts for these invariants.

## v2.13.33 — Container assurance and staged promotion

- Embedded exact Git commit identity into production container builds and exposed non-secret runtime build/version health metadata.
- Added HIGH/CRITICAL Trivy container vulnerability gating.
- Added GitHub/Sigstore provenance + SBOM attestation for sanitized release ZIPs when repository permissions support it.
- Added exact-SHA deployment smoke and protected staging → canary → production promotion workflow.
- Promotion requires a successful CI run for the exact commit and rejects a runtime that serves another build SHA.
- Added permanent release-pipeline contracts and release-preflight enforcement.


## v2.13.39 — Storefront polish and real development seed photos

- Reviews are larger and aligned opposite the live price across card variants.
- Promoter badges now show the dynamic commission money amount instead of a percentage.
- Top Brands no longer drops approved brands that currently have zero published products.
- Daily Deals countdown is live and the section only renders genuine discounts.
- Footer typography and related-product cards are cleaned up for readability.
- Local development seed media can safely download validated Pexels reference photos and falls back offline without breaking `db:setup`.

## v2.13.43

Storefront media fitting, expanded category taxonomy with original-ten More/Less disclosure, permanent mobile search, hidden phone nav strip, larger footer socials, and scroll-hiding capsule bottom navigation.

## v2.13.44

- Made the center mobile bottom-nav item a unique elevated **Sell** / seller-signup action with a plus icon.
- Balanced the mobile search-to-hero spacing to 7px, matching the hero-to-next-section rhythm.
- Kept the homepage category **More** control visible even before extra categories finish loading.
- Preserved the original ten visible categories and More/Less expansion for the remaining taxonomy.
- Advanced the public service-worker cache to `classic-mart-public-v22`.

## v2.13.45
- Restored the Shop by Category right arrow on phone and desktop.
- Category cards remain in one horizontal carousel; More adds all extra categories into the same swappable row and Less restores the original ten.
- Public cache namespace advanced to v23.

## v2.13.46
- Production launch cleanup: all-category carousel, production-only bootstrap/data gate, clean allowlist artifact, Render Blueprint, supervised web+worker launch, durable-storage guard, live-provider fail-closed configuration, and self-contained ClamAV scanning.

### v2.13.46 final production dependency cleanup
- Removed development-only dependency declarations from the generated production launch package while preserving them in the engineering source/release.
- Kept Docker runtime installation on `npm ci --omit=dev` and synchronized staged lockfile root metadata.

## v2.13.48 external-first final consolidation

- Development no longer auto-starts/reconfigures local MongoDB.
- Added guarded Atlas + R2 starter catalogue setup and clean-app packaging.

## v2.13.56 — Production dashboard integration

- Replaced the temporary dashboard bridge/selector with one server-authoritative production dashboard covering all 123 approved pages.
- Bound dashboard data and actions to real Classic Mart models/services and added missing persistence for addresses, notifications, conversations, coupons and subscriptions.
- Merged Finance, Promoter, Support, Warehouse, Seller, Business and Customer capabilities into the approved dashboard design while retaining specialist audited workflow endpoints underneath.
- Removed legacy/versioned dashboard runtime names, duplicate role-home dashboard implementations and browser-controlled workspace switching.

## v2.13.59 — Promoter dashboard checkpoint
- Rebuilt the 15-page Promoter dashboard from the approved uploaded design after the Customer and Seller checkpoints.
- Connected real campaign applications, tracking links, attribution analytics, commission lifecycle, payouts, referrals, seller relationships, messages, and promoter verification/profile data.
- Added safe Promoter payout account/request actions through the existing payment service, including method-specific destination validation and per-form idempotency keys.
- Promoter accounts now resolve from `/dashboard` to `/promoter` server-side; no manual role/workspace selector exists.
- Other role dashboards remain intentionally disabled until their own sequential rebuild checkpoint.


## v2.13.60 — Business Buyer dashboard checkpoint
- Rebuilt the 6-page Business Buyer dashboard from the approved uploaded design after the Customer, Seller, and Promoter checkpoints.
- Connected the real organization-scoped procurement engine: memberships, budgets, requests, approvals, quotes, purchase orders, invoices, templates, immutable documents, catalogue SKU search, payments, statements, and audit history.
- Business accounts now resolve from `/dashboard` to `/business` server-side; no manual role/workspace selector exists.
- Preserved owner/admin/buyer/approver/viewer least-privilege controls and server-validated organization switching.
- Removed the old Business workspace dashboard; Support and later role dashboards remain intentionally disabled until their sequential rebuild checkpoints.


## v2.13.61 — Support dashboard checkpoint
- Rebuilt the 9-page Support dashboard from the approved uploaded design after the Customer, Seller, Promoter, and Business Buyer checkpoints.
- Connected real country-scoped ticket queues, SLA/ownership filters, customer/order lookup, returns, disputes, review issues, CSAT/service reports, macros, and Support settings.
- Support accounts now resolve from `/dashboard` to `/operations/support` server-side; no manual role/workspace selector exists.
- Kept Trust moderation behind independent Trust/catalogue permissions and made customer lookup search-triggered to minimize unnecessary PII exposure.
- Removed the old Support workspace dashboard; Warehouse/Logistics and later role dashboards remain intentionally disabled until their sequential rebuild checkpoints.

## v2.13.74 — Exact Final 19 Customer dashboard restoration

- Rebuilt the Customer dashboard presentation from the approved Final 19 structure instead of the reconstructed v2.13.72 shell.
- Restored the full icon sprite, Customer Dashboard pill, approved header/sidebar hierarchy, overview composition and all 13 Customer page composition contracts while retaining real backend data/actions.
- Added exact-reference regressions for structure and mobile/profile behavior; no Seller or later-role dashboard was introduced.

