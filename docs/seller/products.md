# Seller products and independent review

This milestone connects the approved seller product editor and product review
queue to MongoDB. It completes product creation through publication, buyer cart
eligibility, archiving and resubmission. It does not certify the whole marketplace
or external payment and messaging providers for production.

## Working routes

- `/seller/products`: current-store products, status/search filters and cursor pages.
- `/seller/products/new`: create a private product and its first priced variant.
- `/seller/products/:publicId`: details, category attributes, variant options,
  prices, images, warehouse creation, stock adjustments and publishing actions.
- `/moderation/products`: submitted products in the reviewer's assigned countries.
- `/moderation/products/:publicId`: independent claim, release, changes, rejection
  and approval, with actual listing information and review history.

The corresponding `/dashboard/seller-products`, `/dashboard/seller-add-product`
and `/dashboard/moderator-products` URLs permanently redirect to these routes.
Navigation enables these completed pages alongside store settings and seller
verification. Other seller/reviewer dashboard pages remain unavailable.

The approved shell and original three dashboard stylesheets remain unchanged.
New forms use their existing components. Scoped supplemental styles make the
stock tables readable on phones. Values and errors are escaped; validation errors
preserve the affected form's bounded input without overwriting another form.

## Product lifecycle

New products are private drafts. Sellers choose an active country-compatible
category and optionally an approved brand; selling country and currency come
from the store. Prices use the currency's actual minor-unit precision and must
be positive. Required category attributes are validated by their declared type.

Submission requires a verified store, complete listing information, an active
variant with usable warehouse stock, at least three sanitized images and a
quality score of at least 45. Submitted and approved catalogue details stay
locked. Sellers can withdraw to draft; this removes public visibility and prior
approval before editing and resubmission.

An independent reviewer must claim a submitted product before deciding. Store
owners and active/invited members cannot review their own listings. Changes and
rejections require a reason and preserve sanitized private images so a textual
correction can be resubmitted. Approval makes images approved but keeps the
product private until the seller publishes it. Restricted/high-risk products
require two distinct reviewers; neither can be a product/store owner.

Stock can change without editing an approved listing. Negative adjustments
cannot consume reserved, damaged, quarantined or lot-controlled stock. Every
adjustment records an inventory movement. An inactive, foreign-country or
unrelated warehouse cannot make a variant available for sale. Advertised stock
uses the largest eligible warehouse, matching checkout's existing single-
warehouse reservation strategy; quantities from separate warehouses are not
combined into an unfulfillable cart line.

Public listings, brand/seller counts, image access, cart mutations and order
placement check verified stores, active categories, approved brands, correct
variant relationships/currency and restricted-product approval. Final checkout
rechecks eligibility within its transaction before reserving stock. Archiving
removes the listing from public purchase paths.

## Security and performance

Authentication, verified email, completed onboarding, production privileged MFA,
CSRF, upload/mutation rate limits, noindex and private/no-store caching protect
the dashboard routes. Each mutation checks current account/token version, store
membership and required capabilities again inside the transaction. Reviewers
have permission, authoritative country and conflict-of-interest checks.

Every product child mutation forces an optimistic parent revision write, even
for metadata updates that do not change quality. Stale forms fail rather than
overwriting a concurrent edit, upload or review. Product, child records,
notifications and mandatory audit evidence commit together; audit failure rolls
them back. Transaction reads follow MongoDB snapshot semantics; account/store
changes committed after the snapshot are handled by subsequent requests.

Uploads are bounded at 8 MiB and 16 million pixels, verified as supported raster
images and re-encoded as WebP without original metadata. Full/thumbnail objects
are cleaned up on failed writes; replacement preserves the old image until the
new database state commits. Private image reads recheck account, membership,
MFA and reviewer scope. Storage keys are not returned to the editor.

Product pages contain at most 50 records; stock pages contain at most 200.
Products support at most 50 variants and 10 images; stores support 200 warehouses.
Review stock displays the first 200 records with an explicit notice when more
exist. Approval checks authoritative stock independently of displayed rows.
Category and brand pickers are bounded at 200 options; an existing approved
brand remains available when outside that initial set. Larger global catalogues
will need searchable option paging. Cursor sort indexes support product and
inventory reads. Public catalogue caches invalidate after committed mutations.

## Verification and remaining work

Verified on 2026-10-08: the canonical suite passed **381 tests, zero failures and
zero skipped**. Project/import, security, frontend and functionality checks,
MongoDB replica-set verification, financial integration and concurrency audits
passed. The dependency audit reported zero vulnerabilities. Product-specific
Chromium tests passed desktop and mobile creation, replacement, stock, review
and publication, including readable phone stock cells and no page overflow.

The integration test exercises real password/session authentication, store
capabilities, current membership and country isolation; complete standard and
restricted review flows; price precision and category attributes; stale revisions
and concurrent uploads; stock protection; mandatory audit rollback and orphan
cleanup; public cart and final purchase checks; archive/resubmission; and Chromium
form submissions at desktop and phone sizes.

Run it with an isolated local MongoDB replica set and Chromium:

```sh
CLASSIC_MART_LIVE_TEST_MONGO_URI='mongodb://127.0.0.1:27019/classicmart_verification_test?replicaSet=classicmarttest' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node --test test/seller-products-live.test.js
```

Queued product review emails use the existing email outbox. Tests explicitly use
the development mail sink; they do not prove Gmail delivery. No real eSMS or
Pesapal calls were made. Orders/fulfilment, returns, staff management, seller
finance, subscriptions and the remaining role dashboards still need their own
complete approved-UI integrations and validation.

A separate run of the broader public-site Playwright suite did not pass: it
reported 27 failures, three passes and four skips. Existing public accessibility
issues include contrast, search/filter accessibility, nested controls, focus
indicators and homepage overflow at 320 CSS pixels. Some browser cases also
failed before application assertions because the runner could not create a
headless profile; some test selectors are ambiguous. The affected public views,
styles and scripts are unchanged from `ee7589a`. These findings are remaining
site-wide work and prevent a claim of overall production readiness.
