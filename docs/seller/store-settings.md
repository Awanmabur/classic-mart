# Seller store-settings milestone

Verified on 2026-10-08. This completes store identity and operating preferences;
it does not certify the entire seller dashboard or marketplace for production.

## Working flow

Seller onboarding and login now land at `/seller/store`. The previous
`/dashboard/seller-store` URL redirects permanently to that path and preserves
query parameters. Live pages do not add fragments or read preview role preferences.

The approved dashboard shell, styles, cards, input layout and button classes are
retained. Store profile and business forms use database values, and header badges
use the signed-in user's actual data. Profile completion and verification status
are calculated from saved records; there are no demo balances, bank accounts,
ratings or verification claims.

Store identity supports name, description and support contact details. The phone
country selector uses configured active countries, validates country-specific
possible lengths and saves E.164 numbers. Public support contacts are separate
from login email and verified identity phone; editing them never grants identity
verification. Business settings persist primary category, pickup city and
fulfilment preference. These preferences do not dispatch orders or change existing
orders, and selecting a fulfilment mode does not certify a warehouse integration.

Validation errors remain inside the approved UI and preserve bounded, escaped
form values. Conflicting edits show current saved values and require a new
submission. Password and authenticator management use the existing security centre.

## Access and data integrity

- Authentication, email verification and completed onboarding gate every route.
  Production's required seller MFA enrollment gate remains active. The real
  enrollment and confirmation routes are exercised with this feature.
- Access requires both the seller workspace and an active store owner/admin
  membership with the staff capability. Membership is checked again inside each
  update transaction. Forms never select a target store.
- CSRF protection, mutation rate limiting, private/no-store caching and noindex
  headers remain enabled.
- Schemas whitelist editable fields. Country, currency, ownership and verification
  status cannot be changed through these forms. Suspended/closed stores cannot be
  edited. An optimistic revision prevents stale forms from overwriting newer edits.
- Store changes and their audit evidence commit together. If audit persistence
  fails, the update rolls back. Public storefront caches invalidate after commit.
- Simultaneous first visits reuse the owner's unique store instead of failing
  with duplicate-owner errors. Twenty concurrent first visits are tested.
- Reads are scoped to the current store and account. Header reads execute
  concurrently and reuse the existing request-scoped read helpers; this page does
  not load the entire seller operation dataset.

## Verification

The full suite passed: **372 tests, zero failures, zero skipped**. Project/import
checks, the security gate, frontend audit and functionality audit also passed.

The seller integration test uses a new, uniquely named local MongoDB test database
on a replica set and drops only that database afterwards. It tests onboarding,
real password/session authentication, MFA enrollment, store creation, both forms,
country/phone validation, immutable fields, stale submissions, transactional audit
rollback, cross-store isolation, staff denial, revoked membership and suspension.
Chromium submits the business form at desktop and mobile sizes, checks tab
switching, clean URLs, horizontal overflow and browser errors.

Run the focused tests with a local replica-set URI and Chromium:

```sh
CLASSIC_MART_LIVE_TEST_MONGO_URI='mongodb://127.0.0.1:27019/classicmart_verification?replicaSet=classicmarttest' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node --test test/seller-store-live.test.js test/seller-store-validation.test.js
```

## Remaining seller work

The remaining seller dashboard pages are disabled and return 503 in both
development and production. No preview numbers are served as seller operations.
Their existing backend services are retained for the next integrations.

Verification document submission/review, staff management, product lifecycle,
inventory, orders, shipping, returns, customer communication, growth, financial
settlement and subscriptions still need their own complete UI-to-backend work and
validation before being enabled. Store verification is read-only in this milestone.
Email/SMS delivery and Pesapal settlement were not tested against live providers
in this change. Overall production readiness remains unverified.

The subsequent [verification milestone](verification.md) now connects document
submission, independent review, rejection, appeal and approval. The remaining
scope above describes this earlier store-settings checkpoint.
