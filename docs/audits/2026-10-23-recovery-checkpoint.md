# End-to-end recovery checkpoint

For the subsequent full-run failures, fixes and current remaining verification,
see the [25 October verification checkpoint](2026-10-25-verification.md).

This is a recovery branch, not a production release. The baseline is
`ae0936589e6ef1144ef8ba5495e2d40571b52ebc` (v2.13.74). The missing working copy
has been rebuilt from the recorded remediation scope; previous lost test
results do not validate this replacement.

Current local executable evidence, reviewed on 24 October 2026:

| Exercised suite | Passing checks | Scope shown by the current run |
| --- | ---: | --- |
| Loyalty recovery, market migration and funding unit suites | 13 | Original refund/chargeback/referral lineage, recovery debt, independent provider proof, replacement index failure/retry and exact funding/rounding conservation |
| Privacy recovery | 8 | Owned encrypted exports across batches and markets, storage/read revocation, independent corrections, restrictions, deletion obligations and durable cleanup records |
| Funded reward payment/refund recovery | 7 | Actual wallet cash and platform expense, exact full/partial refund accounting, selected-market wallets, revoked sessions and recovery debt |
| Checkout recovery | 28 | Actual HTTP authentication/CSRF, reviewed SKU/contact/address, eleven concurrent source edits, private source fences, revoked cancellation authority, remaining refund lineage, tax/subsidy accounting, replay and mobile order identifiers |
| Business recovery | 7 | Accepted company authority, independent budget and credit review, canonical private records, actual carrier/Warehouse/recipient proof, commitment expiry and recurrence |
| Seller recovery | 9 | Accepted team authority, independent campaign/policy decisions, typed billing with local provider verification, renewal/expiry/reversal and current store/settings authority |
| Seller settings authority | 15 | Current account, Device, accepted staff and owner authority, one version increment/audit, revoked access and transaction rollback |
| Seller store forms | 1 | Actual authenticated settings forms, stale-edit rejection and store/staff isolation |
| Seller personal account shell | 10 | Own profile save and private avatar lifecycle, personal data isolation, operational-role shells, explicit accepted store selection/revocation and actual desktop/phone menu navigation |
| Public account/Seller entry and destination unit | 11 | Intentional Seller signup/enrollment, canonical personal profile entries, verification/MFA continuation and desktop/phone home links |
| Super Admin recovery | 10 | All 21 canonical destinations, current global grants/MFA, scoped records/CSV, atomic independent staff grants, policy/plans/privacy/CMS/features/security, a complete 67-record scoped CMS backlog with older-source edit and bounded credit review |
| Delivery recovery | 10 | All six canonical pages, independent verification, physical custody and recipient proof, COD reconciliation, return receiving/intake, payout destination review, revocation, measured reports and desktop/phone Chromium rendering |
| Customer recovery | 6 | Complete owned order keysets/status filters, versioned addresses and concurrent default selection, exact cart-to-wishlist movement/replay/rollback, full owned wallet ledger CSV, sanitized private avatars and physical cleanup recovery |
| Customer browser journey | 1 | Actual Chromium signup, popup Security/Profile actions, address create/edit, avatar preview/upload/delete, phone navigation and logout |
| Aftersales recovery | 8 | Owned collection codes, buyer refund consent/decline, unchanged inspection lineage through independent Finance completion, all departmental/seller queues, private evidence and authority/source/audit rollback |
| Reviewed raw partial authorization | 1 | Direct reviewed partial calls remain bound to their actual caller and exact arguments |
| Finance reporting and calendar/CSV unit | 11 | Complete market/currency-scoped totals, bounded keysets/full private CSV, all six exception source links, scoped audit evidence, current grants/authenticator, revoked streams and real market calendars |

The separate Finance payment/refund, payout and reconciliation suites also
passed all **43 checks**, including actual Customer cancellation/restocking,
exact refund reversal, current Devices and independent Warehouse COD review.
The standalone concurrency audit passed all of its 20-way native MongoDB
races for payment, refund, payout, shipment, procurement, return and Warehouse
claims. These database races complement the authenticated financial suites.

Counts above include a passing parent test where the suite uses subtests. They
are not counts of distinct production features. The complete passing suites
have no skipped or cancelled checks. Privacy and funded reward suites passed
inside an earlier mixed invocation whose checkout fixture failed; checkout
subsequently passed its separate complete 28-check rerun. Business, Seller and
Super Admin likewise passed in a mixed invocation containing other failures.
Account entry and aftersales passed complete reruns inside mixed invocations
whose other tests still failed. A later complete Finance/Seller account/store
invocation passed all 21 checks with zero failures or skips. Those earlier
mixed invocations are not described as passing runs; newer complete suite
results supersede their earlier failures.

The expanded Super Admin suite now passes all ten checks, including the new
CMS backlog regression. That regression follows all 67 matching UG/global
records without duplicate IDs or list revision bodies, excludes Kenya-only
records, and selects and edits an actual record beyond the former 50-record
limit. It also verifies the source version, audit, retained revision and stale
edit rejection. Its first run exposed the scalar-country query defect; a
subsequent fixture check incorrectly required a particular ordering of cache
directives. The source fix and independent private/no-store assertions passed
the final complete rerun. The expanded Finance suite's eleven checks passed
in the earlier mixed invocation whose CMS cache-header assertion still failed.

The canonical MongoDB integration audit passed all twelve stages, including
the recovered Business/Delivery and real physical-custody workflows. Its final
loop checked every one of the eleven generated ledger transactions for equal
debits and credits. This was an isolated local integration run; provider
fixtures and local log transports do not establish external payment or
message delivery.

The public layout sweep passed 72 route/viewport cases (24 routes at 1366,
390 and 320 pixels), checking 42 visible text controls. It reported no page
errors, HTTP errors, horizontal overflow, clipped control text or suspicious
vertical text alignment. Full dashboard visual fidelity, accessibility and
production performance verification remain separate checks.

The HTTP recovery wrapper also completed actual public SEO checks: published
product links, canonical URLs and Product structured data, readable content
without JavaScript, missing-product 404, published-only product sitemap and
private-page noindex. These checks do not establish search ranking, live crawler
indexing or a complete accessibility/performance audit.

The saved local evidence is in `/tmp/classicmart-loyalty-funding-20261023-pass.log`,
`/tmp/classicmart-privacy-funding-pass-checkout-fixture-failure.log`,
`/tmp/classicmart-checkout-28-pass.log`,
`/tmp/classicmart-role-recovery-round2.log`,
`/tmp/classicmart-role-final-fixture-failures.log`,
`/tmp/classicmart-delivery-pass-aftersales-grant-failure.log`,
`/tmp/classicmart-account-profile-fixture-failures.log`,
`/tmp/classicmart-customer-recovery-6-pass.log`,
`/tmp/classicmart-customer-browser-pass.log`,
`/tmp/classicmart-aftersales-pass-account-store-followup.log`,
`/tmp/classicmart-finance-seller-account-store-21-pass.log`,
`/tmp/classicmart-super-cms-10-pass.log`,
`/tmp/classicmart-finance-exceptions-11-pass-cms-header-fixture.log`,
`/tmp/classicmart-integration-12-stages-pass.log` and
`/tmp/classicmart-production-public-layout.log`. These are workspace logs, not
packaged production release evidence. Source gates run during this recovery
passed: `npm run check` (692 import/export and 724 syntax files),
`npm run security:check` (664 source files), `npm run frontend:audit` and
`npm run functionality:audit`. Final gates must still run against the eventual
release commit.

The source checkpoint includes the restored Customer controls, private avatars
and privacy operations; dedicated Business, Delivery, Seller and Super Admin
routes; specialist referrals and buyer-consented refund proposals; typed Seller
subscriptions; and reviewed reward funding. This paragraph describes source
scope, not completed release validation. Some tests and integrations remain in
progress and must pass before merging a release.

Outstanding verification includes complete Customer source links, broader
aftersales history and notification preference checks; the complete canonical
regression suite; the concurrency audit; worker hooks; the full browser and
accessibility suites and dashboard visual sweep; tested reusable environment
installation; and final dependency/security/release checks. The public layout
sweep and twelve-stage integration audit above have passed and do not replace
those remaining gates. Provider credentials,
actual Gmail/eSMS Africa delivery and actual Pesapal sandbox/production
reconciliation remain deployment verification requirements. The local provider
fixture is not evidence of a live external payment.

Keep public Business/Delivery registration gated until their release evidence
is complete. Preserve the approved public and dashboard UI throughout recovery.

The complete revised cloud installer was executed successfully on 24 October:
locked dependencies installed, 693 imports and 725 JavaScript syntax files
passed, and the guarded MongoDB/Redis fixtures became ready. The current
security gate scanned 665 files; frontend and functionality audits passed.
This prepares the environment; it does not substitute for the full canonical
regression, complete browser/accessibility checks or external provider delivery.
Additional local logs: `/tmp/classicmart-finance-controls-43-pass.log`,
`/tmp/classicmart-country-admin-audit-concurrency.log` and
`/tmp/classicmart-production-install-current.log`.
