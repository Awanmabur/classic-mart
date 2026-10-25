# Recovery verification, 25 October 2026

The working branch is `recovery/end-to-end-20261023`. It remains a recovery
branch based on v2.13.74, not a production release. This checkpoint supersedes
the outstanding-check list in the 23 October checkpoint. Counts below include
parent tests where Node reports them; they are not counts of distinct features.

The first complete canonical run finished with **1,248 passing, 94 failing and
13 skipped checks** out of 1,355. Its log is
`/tmp/classicmart-first-full-1248-pass-94-fail-13-skip.log`. The failures included obsolete fixtures
and real product defects. It was a failed run and does not establish release
readiness. The thirteen skips require running the separate live HTTP/browser
fixtures with their external base URLs. The expanded Customer recovery adds
two such externally configured cases; its eight-check wrapper run below
executes them.

The second complete run, using the patched dependency set, finished with
**1,352 passing, two failing and 15 skipped checks** out of 1,369. Both failures
were obsolete static contracts: the former shared privileged browser account
and an exact Nodemailer 10.0.16 pin. Their replacements check separate role
accounts and the patched address-parser version floor. All 31 checks in their
combined rerun passed, including 16 actual fixture safety cases. Logs:
`/tmp/classicmart-second-full-1352-pass-2-static-fail-15-skip.log` and
`/tmp/classicmart-ci-safety-mail-contracts-31-pass.log`. The second full run
remains a failed invocation; a final complete rerun is still required.

Subsequent fixes preserve current authorization checks and the approved UI:

- Scheduled CMS publication reloads the exact approving grant, token and
  revision digest, handles global Super Admin authority and approved rollback,
  and advances a bounded durable scan past blocked or future records.
- Business approval uses the explicit `canApprove` permission for nonowners,
  including the rendered controls and current transactional membership fence.
- Seller finance, relationships and review disputes use current canonical
  account, Device, accepted membership, owner, store and market authorization.
  Invalid Seller support forms retain that authenticated context when rendered
  again, preserving 422 validation and 409 stale-update responses.
- Seller account navigation rejects unavailable or managed owners. MFA
  continuation retains the owned store-invitation inbox. Suspended stores keep
  private case access while fulfilment remains locked.
- Finance history keeps the original currency and verified source lineage
  after a market currency change. Provider-event searches resolve source IDs
  before filtering. COD reconciliation is available after independent Warehouse
  cash review. Historical reads do not relax current payout mutation policy.
- Staff invitation auditing records one transactional event rather than a
  duplicate CLI event.
- Customer wallet, reward and aftersales references resolve actual owned source
  lineage in bounded batches. Focused records remain accessible beyond the
  first page, with original reward currency, effective expiry and no forged
  source IDs. Signed keysets retain complete owned histories.
- Optional email and push apply current notification preferences at queue and
  dispatch time. Offers additionally require marketing consent. Alert claims
  and push queue creation are atomic; unknown historical email work and obsolete
  progress updates cancel. Required security, access, receipts and requested
  service messages remain available.
- Authentication and fulfilment regressions now use actual accounts, Devices,
  accepted store selection, reviewed checkout contacts, independent campaign
  and carrier approval, and private delivery-photo uploads.

Completed targeted runtime evidence after the first full run:

| Complete suites exercised | Result and log |
| --- | --- |
| Current live-server identity, Customer, phone selector, order filters and retired-dashboard checks | All 11 checks passed across the six HTTP wrapper suites; their `/tmp/classicmart-production-*-live.log`, phone-selector and retired-cleanup logs record the individual results |
| Current twelve-stage integration and twenty-way financial/fulfilment concurrency audits | Both passed after the dependency upgrades: `/tmp/classicmart-patched-integration-12-stages-pass.log` and `/tmp/classicmart-patched-concurrency-20-way-pass.log` |
| Reusable CI role fixtures and actual critical browser flows | The tracked test-only seeder created separate Seller/managed Moderator accounts with real MFA; 16 checks passed with four intentional project-specific skips in `/tmp/classicmart-ci-role-browser-16-pass-4-project-skips.log` |
| Public critical browser flows, dedicated Seller/Moderator MFA sessions, strict cross-role denial and mobile Seller product cards | 16 passed, 4 deliberate project-specific skips: `/tmp/classicmart-critical-browser-16-pass-4-project-skips.log`; this preceded the dependency upgrade below |
| Image shapes and hero/promotional motion on desktop/mobile | 18 passed in `/tmp/classicmart-image-motion-18-pass-cart-guest-fixture-failures.log`; its two obsolete guest-checkout fixtures were corrected and passed separately on both viewports in `/tmp/classicmart-cart-checkout-image-2-pass.log` using the upgraded dependencies |
| Customer source links, receipts/refund browser navigation, all five 67-record aftersales histories, addresses, exact wishlist moves, wallet CSV and private avatar recovery | 8 passed, zero failures/skips: `/tmp/classicmart-customer-source-history-8-pass.log` |
| Actual Customer Chromium signup, account controls, address edit, avatar lifecycle, mobile navigation and logout | 1 passed, zero failures/skips: `/tmp/classicmart-customer-browser-20261025-pass.log` |
| Notification choices, campaign consent, privacy restrictions, Seller orders/relationships and Warehouse operations | 41 passed, zero failures/skips: `/tmp/classicmart-notification-privacy-seller-warehouse-41-pass.log`; final notification hardening separately passed all 6 checks in `/tmp/classicmart-notification-final-6-pass.log` |
| Finance reports and reconciliation, including original-currency historical source links and CSV | 24 passed, zero failures/skips: `/tmp/classicmart-finance-history-reconciliation-24-pass.log` |
| Seller orders and inventory, including payment gates, delivery proof, current staff MFA and revocation | 13 passed, zero failures/skips: `/tmp/classicmart-seller-orders-inventory-pass.log` |
| Country Admin settings and all 17 destinations; Finance's 10 destinations; Moderation trust and all 9 destinations; pending Seller and all 23 Seller destinations | These complete suites passed in `/tmp/classicmart-navigation-79-pass-relationship-fixture-failure.log`; the invocation had 79 passes and one separate Seller relationship failure, subsequently fixed |
| Promoter campaigns, Seller relationships and Warehouse operations | These complete suites passed in `/tmp/classicmart-warehouse-promoter-relationship-22-pass-seller-audit-fixture-failure.log`; the invocation had 22 passes and one separate Seller orders audit-fixture failure, subsequently fixed |
| Seller payouts | All checks passed inside `/tmp/classicmart-seller-finance-pass-inventory-stale-fixture.log`; that invocation still failed an Inventory fixture, subsequently fixed |
| Aftersales, Business, Seller account shell/MFA, Finance payouts, gift cards and Super Admin | Complete suites passed inside `/tmp/classicmart-core-followup-83-pass-finance-fixtures.log`; its remaining Finance fixture failures were subsequently fixed and passed the separate 24-check rerun |
| Country growth, Promoter attribution, Seller product browser and Warehouse parcel options | Complete suites passed inside `/tmp/classicmart-fulfilment-promoter-50-pass-fixture-failures.log`; that invocation's remaining unrelated failures were fixed in later runs |
| Seller growth and overview, and nine updated static contract suites | Complete suites passed inside `/tmp/classicmart-static-seller-requests-fixture-failures.log` or `/tmp/classicmart-seller-finance-inventory-two-fixture-failures.log`; the remaining Seller finance/inventory fixtures were subsequently fixed |

Mixed invocations above are deliberately not described as passing runs. The
earlier checkpoint retains the separately completed checkout, privacy, funded
reward, Customer browser, Delivery, twelve-stage balanced-ledger integration,
twenty-way native MongoDB concurrency and 72-case public layout evidence.

The full public accessibility suite was executed with Chromium on desktop and
mobile: **15 passed, 26 failed and one desktop-only touch-target case skipped**.
Failures were real contrast findings and small hero-dot targets, including
opened previews, search suggestions and filters. The existing approved bright
orange/white and pale-label combinations contribute to the contrast findings.
The scan remains enabled; it has not been weakened or reported as passing.
Log: `/tmp/classicmart-a11y-approved-palette-and-controls-failures.log`.
The hero targets were subsequently expanded to actual nonoverlapping 24px
buttons while retaining the visible dot/pill shapes. All ten motion checks
passed, including actual corner clicks on the expanded targets. Broader
palette changes await the user's preference; the accessibility suite remains
a release blocker and needs its final rerun.

The HTTP recovery run also passed the current published-product canonical,
structured-data, no-JavaScript content, 404, sitemap and private noindex checks.
Current remaining work includes the second complete canonical regression,
current public browser/image/motion checks and final source/dependency gates.
The accessibility contrast findings remain unresolved pending the user's
palette preference. Complete source changes are not a production release until
their required gates pass.

The dependency audit initially found seven advisories, including five high
severity findings. Registry metadata provided official patched releases even
though the first audit did not offer an automatic fix for exact package pins.
The application now pins Express 5.3.0, Multer 2.5.0, Nodemailer 10.2.1 and
Zod 4.6.7; the lockfile resolves body-parser 2.4.0 and ip-address 10.7.4.
`npm audit --audit-level=high` subsequently reported **zero vulnerabilities**.
The compressed-body parser and constrained-array validation paths were
reachable, so these upgrades address real exposure rather than suppressing
the audit. Package integrity and TLS verification stayed enabled.

The complete reusable installer was rerun against that lockfile: frozen
dependency installation, 698 import/export checks, 730 syntax files, the
project gate, and guarded MongoDB/Redis readiness passed. The current security
static gate scanned 668 files; both 40-view frontend/functionality audits
passed. Log: `/tmp/classicmart-production-install-ci-final.log`.
The complete runtime regression must still validate the upgraded dependency
set before release.

CI now seeds separate role accounts before its browser gate, rather than
silently skipping authentication because only Admin credentials exist. The
seeder refuses production mode, nonloopback or unapproved databases, missing
replica-set declarations, unsafe credential output and forged GitHub command
files. It never deletes existing data. Local credentials use a new 0600 file;
CI masks passwords and both combined and individual recovery codes before
exporting them to the runner's environment file. The local setup uses this
same tracked seeder, with strict authentication explicitly enabled.

Local provider fixtures and log transports do not prove actual Gmail/eSMS
Africa delivery, live push delivery or Pesapal reconciliation. Credentials and
real provider verification, deployment configuration, backups and production
launch checks remain release requirements. No claim of 100% security, SEO,
search ranking or production capacity follows from the local checks.
