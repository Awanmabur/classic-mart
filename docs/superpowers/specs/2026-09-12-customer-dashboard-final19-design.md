# Classic Mart Customer Dashboard — Final 19 Design

## Scope
Build only the Customer workspace on Classic Mart v2.13.70. The uploaded Final 19 package is the sole visual source. Seller and every other workspace remain absent until the Customer package is approved.

## Customer pages
Exactly 13 canonical pages: dashboard, orders, wishlist, addresses, rewards, wallet, returns, support, profile, categories, cart, notifications, club.

## Architecture
- Canonical routes: `/dashboard/<pageId>` and `/dashboard` -> `/dashboard/dashboard`.
- One Customer shell with the uploaded Final 19 structure and exact source CSS files.
- Page-scoped server loaders; never preload all 13 pages.
- Real authenticated identity and real backend/domain data only. No localStorage role switching, fake identities, demo metrics, or fake success actions.
- Customer-only access at this checkpoint. Other roles go to `/` until their approved dashboard checkpoint exists.
- Existing storefront/account/payment/trust services stay authoritative.

## Missing backend functionality added in this checkpoint
- Customer address CRUD with one-default invariant and audit events.
- Customer notification read state/preferences.
- Customer wallet top-up through Pesapal with idempotent verified ledger credit; no stored card credentials.
- Classic Club summary derived from real loyalty/spend data.

## Security and performance
Require authenticated, verified, onboarded Customer users. Use CSRF, ownership filters, audit events, safe redirect allowlists, idempotency for money, provider-status verification before wallet credit, no raw provider payloads in views, pagination/bounds, and page-scoped queries.

## Release gate
The release must fail if any non-Customer dashboard workspace is added. Package as v2.13.71 and stop for user approval before Seller.
