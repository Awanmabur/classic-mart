# Seller verification milestone

Verified on 2026-10-08. This connects seller verification and its independent
review to the approved dashboard. It does not certify the whole marketplace for
production.

## Working flow

Store settings link to `/seller/verification`. The old seller onboarding page
redirects permanently to this canonical path. Individual sellers upload identity
evidence; registered businesses also supply current registration evidence and a
registration number. Sellers upload documents first, complete their legal details,
accept the declaration and submit for review. Validation stays inside the approved
UI. Submitted and appealed cases are locked against document changes.

Moderators land at `/moderation/verifications`, a country-scoped queue with 50
cases per page and a cursor for the next page. They open a case, view private
evidence, claim it and approve or reject it. A rejection requires a reason, which
appears back on the seller page. Sellers can appeal using the same evidence, or
replace rejected required documents and submit again. An approved decision marks
the store verified. Sellers cannot grant that status themselves.

The approved shell, cards, form layout and button classes are retained. Base
stylesheets are unchanged. Pages use database values and account header data;
there are no fabricated verification claims or queue totals. Other seller and
moderator dashboard pages remain disabled until their workflows are connected.

## Authorization and integrity

- Routes require authentication, verified email and completed onboarding when
  normal identity enforcement is enabled. Existing operational MFA enrollment
  gates remain active. Private evidence requires MFA whenever the configured
  privileged MFA requirement is enabled, including on the legacy media URL.
- Seller actions require an active owner/admin store membership. Membership and
  store status are checked again inside each mutation transaction. A revoked
  uploader cannot retain access merely because they uploaded a document.
- Reviewers need catalogue moderation permission and operational access to the
  store's country. Owners, applicants and current/invited store staff cannot
  claim or decide their own cases. Only the assigned reviewer can release or
  decide a case. Supervisors receive no implicit self-review exemption.
- CSRF, upload/mutation limits, private/no-store caching and noindex headers stay
  enabled. Multipart uploads validate CSRF after parsing and before persistence.
- Revision checks prevent stale edits and conflicting claims. Only current
  document references count toward submission and approval. Replaced documents
  are marked superseded and cannot provide additional approval evidence.
- Documents, verification state, store approval, quality-review records, in-app
  notifications, email delivery jobs and mutation audit records commit in one
  MongoDB transaction where applicable. Audit failure aborts the change. Failed
  uploads remove their object only after confirming no document was committed;
  uncertain database outcomes preserve evidence for reconciliation. Storefront
  caches invalidate again after a committed decision.
- Review queues return a bounded public projection rather than identifiers,
  document objects or entire country store lists. Review history is bounded to
  200 entries; authoritative audit records remain separate.

## Private evidence

Uploads accept JPEG, PNG, WebP and AVIF images, up to 8 MiB, at least 320 by 320
pixels and at most 16 megapixels. The existing malware scanner runs before image
processing. Sharp validates the actual raster content, removes EXIF metadata,
resizes to a maximum of 2400 by 2400 and re-encodes WebP.

New verification images are stored as AES-256-GCM encrypted objects. Fresh nonces
and authenticated storage identities prevent ciphertext tampering or swapping
objects between keys. Authorized routes decrypt images in memory; storage keys
are not exposed in page data. Registration and tax numbers use the existing
AES-256-GCM identifier encryption. Production must retain a securely managed
`DATA_ENCRYPTION_KEY`, including in backups; losing it makes evidence unreadable.

Legacy unencrypted documents remain readable behind the strengthened access
checks. This change does not migrate existing objects. Before deployment with
legacy evidence, encrypt that inventory and confirm private storage/bucket access.
R2 permissions and an external malware scanner were not verified against live
services in this milestone.

## Notifications and provider limits

Submission, appeal and decisions produce in-app notifications. Verified owners
also receive email jobs through the existing worker's retrying delivery queue.
Emails contain generic status only, without documents, identifiers or review
reasons. Run the existing worker alongside the web process for queued delivery.

Tests use `MAIL_MODE=log`: they verify queued processing and explicitly record
that no external email was sent. Gmail delivery, eSMS Africa delivery and Pesapal
settlement were not verified with live credentials here. Seller verification does
not send SMS or require a second identity verification during signup.

## Verification evidence

The full suite passed: **374 tests, zero failures, zero skipped**. Project/import
checks, the security gate, frontend audit and functionality audit also passed.

The focused integration test uses its own unique local replica-set database and
upload directory, then removes only those resources. It covers real password and
session login, MFA, upload validation and CSRF, encrypted storage and EXIF removal,
replaced evidence, stale forms, required documents, transactional audit rollback,
orphan cleanup, cross-store/revoked-member isolation, country boundaries,
self-review denial, 12 concurrent claims, rejection, appeal, approval, notifications
and bounded queue pagination. Chromium submits and approves a real case, then
checks desktop/mobile URLs, overflow and browser errors. Crypto tests reject
altered bytes, truncated ciphertext and a wrong storage identity.

```sh
CLASSIC_MART_LIVE_TEST_MONGO_URI='mongodb://127.0.0.1:27019/classicmart_verification?replicaSet=classicmarttest' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node --test test/private-evidence-crypto.test.js test/seller-verification-live.test.js
```

Product lifecycle, inventory, staff management, shipping, returns, settlement and
other dashboard workflows still require their own complete integrations before
being enabled. Overall production readiness remains unverified.
