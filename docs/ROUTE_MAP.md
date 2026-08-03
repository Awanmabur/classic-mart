# Route and migration map

## Implemented server workflows

| Method | Route | Access | Authority |
|---|---|---|---|
| GET/POST | `/signup` | Guest | MongoDB user creation |
| GET/POST | `/login` | Guest | Argon2id + server session |
| GET/POST | `/verify-email` | Signed in | Hashed expiring code |
| POST | `/verify-email/resend` | Signed in | Per-user/IP throttling |
| GET/POST | `/forgot-password` | Guest | Generic recovery response |
| GET/POST | `/reset-password` | Guest recovery session | One-use code |
| POST | `/logout` | Signed in | Device/session revocation |
| GET/POST | `/onboarding` | Verified | Server role/profile |
| GET | `/dashboard` | Verified | Real account/session data |
| GET/POST | `/account/profile` | Verified | Server profile/preferences |
| GET/POST | `/account/security` | Verified | Password/device controls |
| POST | `/account/devices/:publicId/revoke` | Verified owner | Object ownership check |
| POST | `/country` | Any | Signed cookie + user preference |
| GET | `/health/live` | Public | Process liveness |
| GET | `/health/ready` | Public | MongoDB/Redis readiness |
| GET/POST | `/seller/onboarding` | Verified seller | Store KYC/KYB workflow |
| POST | `/seller/onboarding/document` | Seller owner | Sanitized private document |
| POST | `/seller/onboarding/appeal` | Rejected seller | Recorded appeal |
| GET/POST | `/seller/products` | Seller owner | Product list/create |
| GET/POST | `/seller/products/:publicId` | Seller owner | Product editor |
| POST | `/seller/products/:publicId/variants` | Seller owner | Create variant |
| POST | `/seller/products/:publicId/variants/:variantPublicId` | Seller owner | Edit variant |
| POST | `/seller/products/:publicId/media` | Seller owner | Sanitize/upload image |
| POST | `/seller/products/:publicId/submit` | Verified seller | Submit moderation |
| POST | `/seller/products/:publicId/publish` | Seller owner | Publish approved product |
| GET/POST | `/seller/products/import` | Seller owner | Transactional CSV import |
| GET | `/seller/products/export.csv` | Seller owner | Catalogue export |
| GET/POST | `/seller/inventory` | Seller owner | Stock and movement workspace |
| POST | `/seller/warehouses` | Seller owner | Create warehouse |
| POST | `/seller/inventory/adjust` | Seller owner | Transactional stock movement |
| GET/POST | `/moderation/products` | Moderator/admin | Product review queue |
| GET/POST | `/moderation/verifications` | Moderator/admin | KYC/KYB review |
| GET/POST | `/moderation/catalogue` | Moderator/admin | Categories and brands |
| GET | `/media/catalogue/:publicId` | Owner/moderator or approved | Normalized product image |
| GET | `/media/verification/:publicId` | Owner/moderator | Private KYC/KYB image |
| GET | `/api/v1/storefront/catalogue` | Public | Published country catalogue |
| GET | `/api/v1/storefront/search` | Public | Country-filtered title/category/brand/store/tag/SKU/barcode search with bounded typo recovery |
| GET | `/api/v1/storefront/products/:productId` | Public | Published product detail |
| GET | `/api/v1/storefront/sellers` | Public | Verified sellers with products |
| GET | `/api/v1/storefront/sellers/:slug` | Public | Verified seller profile |
| GET | `/api/v1/storefront/state` | Customer | Wishlist/comparison/recent state |
| POST/DELETE | `/api/v1/storefront/wishlist/:productId` | Customer | Wishlist mutation |
| POST/DELETE | `/api/v1/storefront/comparison/:productId` | Customer | Comparison mutation |
| POST | `/api/v1/storefront/recent/:productId` | Customer | Record recent product |
| POST/DELETE | `/api/v1/storefront/follow/:slug` | Customer | Follow/unfollow verified store |
| POST | `/api/v1/storefront/sellers/:slug/contact` | Customer | Rate-limited seller contact |

## Preserved public route destinations

`/`, `/about`, `/careers`, `/cart`, `/categories`, `/contact`, `/cookies`,
`/help`, `/payments`, `/press`, `/privacy`, `/products`, `/promoters`,
`/promoters/profile`, `/returns`, `/search`, `/sellers`, `/sellers/profile`,
`/shipping`, `/terms`, `/track-order`, `/wishlist` and `/compare`.

Templates themselves are native `.ejs` files and all live navigation uses clean routes. Legacy `.html` URLs permanently redirect to their clean route. This preserves
bookmarks while allowing all business actions to move behind server routes.

## Staged replacement map

| Current visual page | Authoritative replacement stage |
|---|---|
| Public products, categories, search and seller profiles | Stage 3 (complete) |
| Wishlist, recently viewed and comparisons | Stage 3 (complete) |
| Promoter profiles | Stage 6 (complete/re-audited) |
| Cart, checkout, tracking and order confirmation | Stage 4 (complete/re-audited) |
| Payment selection, wallet and statements | Stage 5 (complete/re-audited) |
| Promoter campaigns and attribution | Stage 6 (complete/re-audited) |
| Delivery and warehouse screens | Stage 7 (complete/re-audited) |
| Returns, contact/help cases, reviews and moderation | Stage 8 (complete/re-audited) |
| Content, legal pages, feature flags and admin reporting | Stage 9 (implemented; release gate pending) |
| Classic AI experiences | Stage 10 (implemented; release gate pending) |
| Installable/offline shell and external APIs | Stage 11 (implemented) |

Stages 1–9 no longer accept demo-only pages as completion. Any remaining future-stage page must explicitly identify unavailable functionality rather than display fake success.

## Stage 5 money routes
- `POST /api/v1/orders/:orderId/payment-intents` — create/retry a server payment intent.
- `GET /api/v1/orders/:orderId/payment` — read payment state for the authorized guest/session or account.
- `GET /payments/return` — provider return; verifies provider transaction before redirecting to tracking.
- `POST /webhooks/flutterwave` — signature-authenticated, deduplicated provider events.
- `GET /finance` — finance/country-admin/super-admin money workspace.
- `POST /api/v1/finance/refunds` — country-scoped provider/COD refund initiation.
- `POST /api/v1/finance/refunds/:id/manual-complete` — second-operator confirmation of COD refund disbursement.
- `POST/GET /api/v1/payout-accounts` — seller/promoter payout destinations (sensitive destination encrypted).
- `POST /api/v1/payouts` — request payout from derived available ledger balance.
- `POST /api/v1/finance/payout-accounts/:id/verify` — finance verification.
- `POST /api/v1/finance/payouts/:id/approve` — first finance approval.
- `POST /api/v1/finance/payouts/:id/submit` — separate finance submission to provider.

### Stage 8
- `GET /account/returns` — buyer protection workspace
- `POST /account/returns` — create return from owned order
- `POST /account/disputes` — create order dispute
- `POST /account/support` — create support ticket
- `POST /account/reviews` — submit verified-purchase review
- `GET /operations/support` — support/trust operations
- `POST /api/v1/finance/returns/:id/refund` — finance-controlled refund from inspected return


### Stage 6
- `/promoter` — verification, campaign marketplace/applications, tracked links/QR/content/analytics/wallet.
- Seller campaign routes — draft, submit, application review and approved facts/channels.
- Country-admin promoter/campaign review routes — server-scoped approval/rejection.

### Stage 7
- `/delivery` — expiring offers, proof/state actions and offline-safe queued actions.
- `/operations/logistics` — shipment assignment, parcels, COD and executable warehouse tasks.

### Stage 8
- `/account/returns` — returns, disputes, support, evidence, verified reviews and trust appeals.
- `/operations/support` — support/trust/review/return queues and controlled actions.

### Stage 9
- `/admin` — Country/Super Admin attention centre backed by live operational queues.
- `/admin/countries` — approval-controlled country, payment, delivery and growth settings.
- `/admin/features` — country/role/percentage/schedule feature rollout requests.
- `/admin/cms` — versioned CMS revisions plus publish/rollback approval.
- `/admin/approvals` — four-eyes approval/rejection centre for high-risk changes.
- `/admin/growth` — reward gift cards, consent-aware campaigns, loyalty/referral operations.
- `/admin/reports` — country-scoped operational/finance/search/seller/promoter reporting.
- `/admin/exports` — privacy allow-listed, approval-controlled, expiring CSV exports.
- `/admin/incidents` — incident register and append-only operational timeline.
- `/admin/health` — live platform health with global internals restricted to Super Admin.
- `/admin/impersonation` — approved single-use read-only impersonation with visible banner and audit.
- `/account/rewards` — customer loyalty balance/history, referral code/history and reward gift-card redemption.


### Business buyer + Seller Growth (cumulative v2.10.0)
- `/business` — company profile/tax data, team memberships/spending limits, budgets, approval requests, quotations/negotiation, POs and repeat procurement.
- `/business/statement.csv` — business purchase-order statement.
- `/seller/growth` — vouchers/bundles/quantity breaks/free shipping/sponsored placements, minimum/scheduled prices, consent-based follower broadcasts and business quote/PO handling.
- `/api/v1/cart/promotions` — server-validated seller voucher application/removal; checkout re-quotes promotions and persists seller discount snapshots.

### Stage 10 — Classic AI
- `GET/POST /ask-classic` — grounded shopping assistant with honest retrieval fallback.
- `POST /ask-classic/visual` — in-memory visual search; query image is not persisted.
- `POST /ask-classic/cart-drafts/:id/apply` — explicit server revalidation/application of an AI-proposed cart draft.
- `GET /api/v1/ai/search` — hybrid lexical/semantic search with hard commerce filters.
- `GET /api/v1/ai/products/:id/similar` — filtered similar products.
- `GET /api/v1/ai/recommendations` — server-ranked recommendations with hard filters.
- `GET /api/v1/ai/products/:id/review-summary` — AI-labelled summary derived only from approved verified-purchase reviews.
- `/seller/ai` — seller drafting/quality jobs requiring seller approval.
- `/operations/support/ai` — suggested support replies requiring human approval.
- `/promoter` AI actions — content constrained to approved active campaign facts/channels/disclosure.
- `/admin/ai` — model registry approvals, prompts/jobs, evaluations, usage/cost/failure observability and advisory triage/forecasting.


### Stage 11
- `GET /app` — installable Classic Mart PWA entry point.
- `GET /offline` — safe offline shell without trusted stock/payment state.
- `GET /openapi/v1.json` — versioned mobile/seller API contract.
- `POST /api/v1/mobile/auth/login|refresh|logout` — opaque rotating mobile sessions.
- `GET /api/v1/mobile/catalogue` and `/products/:id` — published live catalogue.
- `/api/v1/mobile/cart*`, `/checkout/review`, `/orders*` — server cart/order/payment authority.
- `/api/v1/mobile/push-devices*` — encrypted device registration/revocation.
- `GET/POST /seller/developers*` — seller API clients, key rotation/revocation, signed webhook management/test.
- `/api/v1/seller/products|inventory|orders*` — scoped external seller integration API with quota/idempotency/auditing.
- `GET /.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` — configurable native deep-link association.
- `GET /open/product/:id`, `/open/order/:id` — safe web/PWA/native deep-link handoff.
