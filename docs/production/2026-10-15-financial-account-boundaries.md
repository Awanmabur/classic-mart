# Refund and account authorization boundaries — 15 October 2026

This follows the [staff-access migration checkpoint](2026-10-15-access-migration.md).
The approved UI is preserved. This work addresses three demonstrated backend
defects, using real isolated MongoDB fixtures and controlled provider responses;
it does not certify live Pesapal delivery or authorize a production deployment.

## Refund submission uncertainty

The previous refund flow released its reservation after a gateway HTTP 502,
empty/malformed response or a local save failure following provider acceptance.
A subsequent request could reserve the same money again, although the original
external refund might already have happened. Contradictory status/error fields
could also be treated as acceptance, and rejection errors exposed provider text.

The new boundary keeps uncertain disbursements reserved and prevents repeat
submission with either the original request key or a new key. Recording a
provider outcome is distinct from deciding whether it rejected a submission.
External acceptance is not proof that refund disbursement has completed;
independent Finance confirmation still posts the settlement reversal once.

The initial regression ran before service edits: 12 entries, two passed and ten
failed, including the parent result. It demonstrated reserved funds falling from
10,000 to zero in the affected failure cases. The transport-failure case already
retained its reservation; that protection is preserved.

Provider protocol fixtures are not a live certification. The official refund
documentation URL was blocked by a proxy CONNECT 403 during this review; no TLS
or network-policy bypass was used. Real sandbox verification requires configured
Pesapal credentials and the intended test payment/recipient.

## Seller settings authority

The former settings transaction read store membership and store state but did
not recheck the account or fence membership against concurrent revocation.
The baseline regression passed two legitimate settings updates and failed eight
entries, including its parent: suspension, account/session revocation, removed
MFA or verification/onboarding, and a membership revoked after its transaction
read could still update the store.

Settings now require current account/session eligibility and current store
capability at commit. Denied mutations preserve the store and its audit records.
The regression exercises both identity and operations settings without changing
their forms or styling.

## Authenticator enrollment

The security page hid enrollment controls for already-enabled MFA, but direct
requests could start and confirm a replacement using a password and existing
session without the existing factor. A stale pending secret could also replace
the active authenticator and recovery codes.

Enrollment now applies only to active accounts whose MFA is still disabled.
Atomic writes check the pending secret and account/version state; enabling MFA,
revoking sessions, suspending the account, changing the password or replacing
the pending setup invalidates the stale operation. Eligible accounts must prove
their existing factor during explicit disable before enrolling a replacement.

The original regression measured 18 entries: three passed and 15 failed,
including its parent. Coverage includes real HTTP direct requests, unchanged
User/Device snapshots on denial, one successful concurrent activation and
legitimate first enrollment and factor-proved replacement.

## Verification and remaining launch requirements

All fixtures use generated, loopback-only databases with owned cleanup. No live
provider message/refund or production staff write/migration was performed.

The preceding checkpoint's real-service, image-scanning, public accessibility
and independent launch-evidence requirements remain applicable. Development
regressions cannot establish production capacity, provider settlement, complete
WCAG conformance or guaranteed security, rankings or AI indexing.


Final verification against unchanged implementation/test fingerprints, after the
complete reusable install script ran with the frozen lockfile:

| Check | Result |
| --- | --- |
| Complete canonical suite | 1,229 entries: 1,221 passed, eight skipped, zero failures; 29m37.6s |
| Exact skipped files with both owned live web servers | 11 passed, zero failures/skips |
| Focused refund/account/MFA boundary regressions | 46 passed, zero failures/skips |
| Connected dashboard controls/photos in the canonical run | 393 page visits across eight roles at 1366px, 390px and 320px |
| Project/import, security, frontend and functionality gates | Passed |
| Locked dependency audit | Zero reported vulnerabilities |
| Real seeded public SEO requests | Published links, canonical/schema, no-JavaScript content, 404/noindex and public-only sitemap passed |
| Both runtime ZIPs | Frozen production installation, entrypoints and real HTTP/import/icon checks passed |

The eight canonical skips need live base URLs. The separate live run executes
`identity-live`, `customer-live`, `customer-browser-live`,
`phone-selector-browser`, `order-filters-live` and `retired-dashboard-cleanup`
with both actual servers. It covers signup/login/logout, persisted private
customer data, optional phone verification, native calling-code selection with
and without JavaScript, order filters and retired asset responses. Those results
do not change the canonical run's reported skip count. Counts overlap and must
not be summed into a fabricated suite total.

The existing seller-store fixture now refreshes its identity after real MFA
confirmation so direct service calls use the same current token version as its
browser session. Assertions remain intact. No files under `public/` or `views/`
changed. ZIP verification checks CRCs, the complete manifest, every file digest
and current source bytes, allowing intentional runtime package/lockfile and clean
README transformations. Email/SMS provider commands reject missing credentials.

| Runtime package | Manifest files | ZIP bytes | SHA-256 |
| --- | ---: | ---: | --- |
| Production | 664 | 2,736,564 | `04093ae7dd08dfa8e3d950b2af2cab8589960ff2512f5a9a3fb53edb3bf781e4` |
| Clean | 670 | 2,743,405 | `cb58e875ee2fad2fb2cb7711a4b482c62afa9ec7b15be8ab383d8c796b701ecd` |
