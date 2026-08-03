# Delivery stages

Classic Mart follows the supplied master blueprint workflow order, with the user-requested MongoDB architecture replacing PostgreSQL. A stage is complete only when the approved UI, server route, authorization/ownership checks, MongoDB persistence, state transitions, failure states and automated verification are connected. A page or a string-presence test alone is not completion.

| Stage | Outcome | Status in v2.13.6 |
|---|---|---|
| 0 | UI audit, route map, threat model and baseline | Complete / maintained |
| 1 | Foundation, identity, country, roles, onboarding and audit | Implemented + re-audited |
| 2 | Seller verification, catalogue, secure media and inventory | Implemented + re-audited |
| 3 | Storefront, search, discovery and customer catalogue state | Implemented + re-audited |
| 4 | Server cart, configurable checkout, reservation and multi-seller orders | Implemented + re-audited |
| 5 | Provider payments, COD, double-entry ledger, refunds and payouts | Implemented + re-audited |
| 6 | Promoter verification, campaigns, attribution and commission | Implemented + re-audited |
| 7 | Delivery offers/proof/COD and executable warehouse operations | Implemented + re-audited |
| 8 | Returns, exchanges, disputes, support, reviews and trust | Implemented + re-audited |
| 9 | Admin, CMS, analytics and growth | Implemented; broader business/seller commitments completed in cumulative v2.10.0 |
| 10 | Governed Classic AI features | Implemented / cumulative baseline |
| 11 | PWA, mobile and external APIs | Implemented — preserved in v2.13.6 |
| 12 | Hardening, pilot and launch | Application hardening implemented; external launch evidence remains intentionally gated |

## Broader blueprint coverage closed in v2.10.0

The broader business-buyer and Seller Center requirements previously tracked outside the numbered Stage 9 gate are now implemented in the cumulative v2.10.0 build: organization/team/spending permissions, budgets and approval chains, quotations/negotiation, purchase orders and risk-approved invoice terms, repeat/recurring procurement and statements; plus seller vouchers, bundles, quantity breaks, free shipping, sponsored disclosure, minimum/scheduled prices and consent-based follower broadcasts. Server checkout recomputes seller-funded discounts and settlement/refund logic uses the discounted seller net. Multi-seller business requests split into seller-specific approved quote allocations, support partial-order/remainder-close lifecycle, and move budget commitment to actual spend on PO fulfilment; bulk CSV procurement/audit history and seller margin preview are included.

## Stage 1 — identity and authorization

- Server signup/login/logout, email verification, password reset/change and Argon2id hashing.
- Session regeneration, device records and token-version revocation; Redis-backed sessions are optional and MongoDB-backed sessions are supported.
- Country context plus role, organization/store membership and capability checks.
- Public onboarding cannot self-select support, finance, country-admin or super-admin roles.
- Seller staff invitations and scoped owner/admin/catalogue/fulfilment/finance/support capabilities.
- Production fails closed without explicit transaction-capable MongoDB, independent secrets, SMTP, SMS and malware-scanning configuration; Redis is optional.

## Stage 2 — seller, catalogue, media and inventory

- Seller KYC/KYB, encrypted registration/tax identifiers, private documents, review/re-upload/appeal.
- Multipart KYC/product/evidence forms keep CSRF protection by verifying the token immediately after Multer parsing.
- Images are malware-scanned in production, decoded/re-encoded to WebP, metadata-stripped and privately stored; `clamd` and `clamscan` adapters are supported.
- Category attributes, brands, products, variants, SKU/barcode, moderation and country restrictions are MongoDB-owned.
- Warehouses track on-hand, reserved, damaged, quarantined and bin stock plus batch/serial/expiry lots and immutable movements.
- Reservations are atomic/idempotent and available stock excludes damaged/quarantined quantities.
- Validated CSV preview/import/export and outbox events are present.

## Stage 3 — storefront, search and discovery

- Public catalogue only exposes approved, published, active, country-visible, sellable products.
- Search covers title/category/brand/store/tags/SKU/barcode with bounded typo/synonym recovery and server filters.
- Search events return an ID and product-click conversion can be recorded; zero-result recovery is supported.
- Real rating/sold/review metrics, product Q&A, verified-review read models, price/restock alerts and recently viewed are connected.
- Wishlist/comparison/recent state is server-owned; no commerce state is trusted from `localStorage`/`sessionStorage`.
- Customer↔seller message threads and seller-side Q&A answering are two-sided workflows.

## Stage 4 — cart, checkout and orders

- Anonymous/account carts are server-owned and merged using explicit rules.
- Country settings and MongoDB shipping zones/pickup points determine delivery/tax/payment/return policy; no hard-coded express fee drives checkout.
- Checkout re-quotes inside the transaction, reserves stock atomically and uses an idempotency key.
- One marketplace order creates per-store `SellerOrder` snapshots for fulfilment/finance.
- Order/product/policy snapshots remain immutable after product edits; payment remains pending until Stage 5 verification/COD flow advances it.

## Stage 5 — money

- Hosted Flutterwave checkout keeps PAN/CVV out of Classic Mart.
- Browser redirects do not prove payment; amount/currency/reference/provider status are verified server-side.
- Webhooks require HMAC-SHA256 `flutterwave-signature` and provider events are deduplicated.
- Immutable balanced ledger separates seller payable, platform revenue, tax, provider/COD clearing and promoter payable.
- Refunds support partial continuation. COD refunds use a separate `cod_manual` two-operator disbursement and reversing ledger path rather than pretending to be Flutterwave refunds.
- Payout balance is reserved at request time to prevent double requests; rejection/provider failure reverses the hold. Approval/submission requires separate authorized finance actions.
- Reconciliation can recover pending transactions by provider transaction ID or `tx_ref`.

## Stage 6 — promoter campaigns and attribution

- Promoter verification, campaign draft→submit→country review→active lifecycle and invite-only applications.
- Signed/random tracked links, QR, coupon, channel/UTM/sub-ID metadata and server-side privacy-limited touches.
- Self-referral, duplicate/high-velocity click controls and campaign fact/channel restrictions.
- Item-level commission snapshots use versioned rules and real order item values; payment makes commission payable, refunds reverse it and payouts can move eligible commissions to paid.
- Promoter campaign/content/analytics/wallet UI and seller/admin campaign controls are connected.

## Stage 7 — delivery and warehouse

- Explicit expiring delivery offers; drivers cannot claim arbitrary shipments.
- Per-seller parcels must be fully picked→packed→dispatched/handed-over before outbound pickup is accepted.
- Encrypted + hashed pickup/delivery OTP proof, failed attempt, reschedule and return-to-sender states.
- IndexedDB offline action queue replays idempotently but every action is re-authorized and state-validated by the server.
- Warehouse receive, put-away, pick, pack, dispatch, transfer, cycle-count and return-inspection tasks execute actual parcel/inventory mutations and immutable movements.
- Delivered COD must reconcile exact collection into the ledger before the order becomes paid.

## Stage 8 — buyer protection and trust

- Return eligibility uses the purchase-time policy snapshot and delivered state; quantities/duplicate active requests are validated.
- Private sanitized evidence can be attached to returns, disputes, support and trust cases.
- Return logistics, receipt, condition inspection and refund/exchange decisions are persisted.
- Exchange creates a real zero-charge replacement order/seller-order and commits replacement stock instead of only changing a label.
- Support cannot directly move money; finance executes refunds through Stage 5 controls.
- Disputes/appeals, SLA support, internal/public notes, knowledge articles and CSAT are connected.
- Reviews require verified purchase, block store self-review and support moderation/disputes.
- Counterfeit/prohibited/unsafe/seller-conduct reports create risk signals; authorized enforcement can suspend/restore products/stores, and customers can view/appeal trust decisions.

## Cumulative Stage 1–12 release acceptance

Run `npm run verify:local` (or configure a transaction-capable `MONGO_URI` and run `npm run release:check`). The release gate executes:

1. structure/syntax/EJS/visual/completeness checks;
2. unit/route/security tests;
3. `scripts/audit-integration.js` against a guarded disposable `*-audit-test` database on the configured transaction-capable MongoDB;
4. dependency audit at high severity.

The integration audit executes a real cross-stage path: seed → catalogue → promoter campaign/touch → cart → multi-seller order → COD → warehouse parcel fulfilment → delivery proof → COD reconciliation/ledger → return/inspection → two-operator COD refund → review/dispute/support/trust/risk checks, then verifies every ledger transaction balances. The audit database is dropped automatically unless `--keep-db` is supplied.


### Phone verification hardening (v2.8.2 audit)
Protected account workspaces require both server-verified email and phone. Phone verification codes are single-use server tokens; development may use the log adapter, while production requires the configured Twilio adapter. Changing the phone number clears `phoneVerifiedAt` and requires re-verification.


## Stage 11 — Mobile/PWA and external APIs

- Installable responsive PWA is the approved cross-platform client and reuses the existing Classic Mart UI/data authority.
- Service worker caches only public shell/assets and never caches trusted account/cart/checkout/order/payment/admin/seller/API state.
- `/api/v1/mobile` exposes versioned catalogue, product, account, cart, checkout, order, payment and push-device flows using the same services as the web application.
- Opaque mobile access/refresh tokens are hash-stored, rotated and token-family revoked on refresh reuse.
- Seller Developer Portal issues scoped/expirable/revocable API keys and encrypted one-time webhook signing secrets.
- External seller writes use idempotency, quotas, optimistic inventory versions and audit logging.
- Webhook delivery is HMAC signed, retryable/dead-lettered, HTTPS-only, private-address blocked and DNS-pinned per attempt.
- Provider-neutral push outbox and Android/Apple deep-link association endpoints are included.
- Seeded reference product imagery uses bundled local assets; seller media continues through the approved secure media pipeline.
- Stage 11 readiness tests cover network/offline/background/installability/accessibility and OpenAPI coverage; the MongoDB integration audit now signs off Stage 1–12, including security-event integrity, MFA replay resistance, launch-evidence creation and critical IPS blocking.

## Stage 12 — hardening and launch

- Persistent application IDS/IPS detects common reconnaissance/injection/scanner activity and correlates sensitive-route failures.
- Temporary IP blocks store keyed hashes rather than raw addresses; short positive-cache TTLs propagate revocation across multiple app instances and block-hit logging is throttled to avoid database/log amplification.
- Security events are separate from audit logs, HMAC-protected, include keyed IP/user-agent hashes in SIEM exports, retried to SIEM and dead-lettered on delivery/integrity failure. High/critical events use a finite extended retention window so hostile traffic cannot create unbounded storage growth.
- TOTP MFA has encrypted secrets, hashed single-use recovery codes and atomic time-step replay protection.
- Production privileged roles must enroll MFA; administrative MFA recovery uses four-eyes approval, a MongoDB transaction and session/device revocation so the reset cannot be left half-applied.
- High/critical findings block launch until remediated or four-eyes risk accepted.
- Launch evidence covers penetration testing, WAF, SIEM, load/stress, recovery/PITR, rollback, provider failure, on-call/incident training, controlled pilot and legal/payment/tax/privacy/marketplace review. Every mandatory gate must be `passed`; `not_applicable` does not bypass launch.
- `security:check`, `security:sbom`, `load:smoke`, `backup:drill` and `launch:check` provide repeatable engineering gates.
