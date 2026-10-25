# Recovery of the end-to-end remediation

The [25 October verification checkpoint](2026-10-25-verification.md) records
the passing complete regression, separately exercised live-server cases and
remaining launch blockers. Rows below describe the feature-scoped evidence.

The environment reset removed the uncommitted v2.14 working copy. The last
durable baseline is `ae0936589e6ef1144ef8ba5495e2d40571b52ebc` (v2.13.74)
on `approved-dashboard-ui`. Earlier test counts describe the lost working
copy and are not evidence for this recovery.

The user asked to continue from the recorded stopping point. Preserve the
approved public and dashboard designs; implement live operations rather than
preview fallbacks, and retain explicit workspace authorization boundaries.

| Gap | Recovery scope | Current evidence |
| --- | --- | --- |
| G01 | Authenticated checkout, saved addresses, reviewed cart/contact, funded benefits | Checkout recovery: 28 checks passed; release checks pending |
| G02 | Carrier verification, fulfilment, COD and returns | Delivery recovery: 10 checks passed, including actual physical custody, COD and return intake; release checks pending |
| G03 | Inspected exchange converted to a buyer-consented refund | Complete aftersales recovery passed proposal, consent, source checks and independent Finance completion; release checks pending |
| G04 | Specialist referrals and receiving | Complete aftersales recovery passed departmental/seller queues, private evidence, source/authority checks and rollback; release checks pending |
| G05 | Seller trust cases and appeals | Seller recovery passed suspended-store private responses, evidence and independent appeal; release checks pending |
| G06 | Atomic independently approved staff grants | Super Admin recovery passed accepted invitations, independent grants, stale targets and concurrent decisions; release checks pending |
| G07 | Privacy operations execute the approved request | Privacy recovery: 8 checks passed, including owned exports, corrections and deletion; complete worker regression passed; release checks pending |
| G08 | Privacy legal holds, recovery and restrictions | Privacy recovery passed obligation blocks, interrupted-job recovery, storage revocation and effective restrictions; release checks pending |
| G09 | Customer source links | Eight-check Customer recovery passed source-bound owned receipt/refund/return/exchange/reward/top-up links, private focus and actual browser clicks; release checks pending |
| G10 | Atomic exact-variant cart-to-wishlist move | Customer recovery passed selected owned variant movement, replay, stale requests and rollback; release checks pending |
| G11 | Complete scoped wallet history and CSV | Customer recovery passed all owned ledger rows, opening/closing balances and foreign-account exclusion; release checks pending |
| G12 | Customer history pagination and order filters | Customer recovery passed owned order keysets/status filters beyond the old limit; all five aftersales histories also passed complete traversal; release checks pending |
| G13 | Customer aftersales history | Customer recovery traversed all 67 tied-timestamp records in each of five histories, with no duplicates/foreign records and rejected forged/cross-account/cross-history cursors; release checks pending |
| G14 | Address editing and default invariant | Customer recovery passed all-field edits, stale versions and one default under concurrent writes; actual browser create/edit passed; release checks pending |
| G15 | Policy-controlled funded rewards | Funding unit/live and checkout suites passed exact cash/subsidy/refund accounting; independent policy publication passed; release checks pending |
| G16 | Club, market loyalty, refund/chargeback recovery | Loyalty/migration/funding suites passed lineage, debt and market isolation; Club policy publication passed; full UI/release checks pending |
| G17 | Effective notification and privacy preferences | Final notification suite passed all 6 checks for actual optional delivery, queued opt-out/consent/privacy changes, atomic alert claims, source-bound historical messages and required notices; release checks pending |
| G18 | Private sanitized avatars and durable cleanup | Customer recovery passed raster validation, private sanitizing, replacement/deletion and physical cleanup lease/staging recovery; Customer/Seller browser and ownership checks and worker regression passed; release checks pending |
| G19 | Accepted seller team invitations and capabilities | Seller recovery passed exact-recipient acceptance, retained identity and explicit workspace selection; release checks pending |
| G20 | Reviewed affiliate campaign lifecycle | Seller recovery and twelve-stage integration passed independent campaign/application review, attributed purchase and proportional refund reversal; release checks pending |
| G21 | Verified subscription billing and entitlements | Seller recovery passed local provider verification, frozen terms, renewal, expiry and reversal; real Pesapal and release checks pending |
| G22 | Canonical live Super Admin pages | Expanded Super Admin recovery: 12 checks passed covering all 21 destinations, real operations, scheduled CMS and complete backlog; release checks pending |
| G23 | Canonical Business procurement lifecycle and Seller B2B | Business recovery and twelve-stage integration passed independent approval, reviewed credit, physical delivery settlement, expiry and recurrence; release checks pending |
| G24 | Canonical Delivery workspace | Delivery recovery: 10 checks passed, including six destinations and desktop/phone Chromium rendering; full UI/release checks pending |
| G25 | Finance exception source drilldown | Expanded Finance reporting suite: 12 checks passed, including all six scoped exception source links, historical currencies and private exports; release checks pending |
| G26 | CMS backlog pagination | Expanded Super Admin suite passed all 67 scoped records through keysets, revision-free lists and versioned older-source edit/stale rejection; release checks pending |
| G27 | Measured Warehouse operational reports | Delivery recovery passed actual task timestamps, 57-record fixture, full keyset CSV and revoked export access; release checks pending |

Evidence was reviewed on 25 October 2026. See the
[current verification checkpoint](2026-10-25-verification.md) for exact suite
counts, local logs and the separately tested live-server contexts. Counts
include parent tests where applicable; no row is marked production complete.

The complete canonical regression, all fifteen externally configured cases,
worker checks, integration/concurrency audits, image/motion and layout checks,
tested installation and source/dependency gates passed. The final public
accessibility run still has contrast failures in the approved palette; changes
await the user's preference. Actual provider delivery/payment, production
deployment and launch evidence, and real independent carrier/credit reviews
remain release conditions.
