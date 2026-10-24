# Recovery of the end-to-end remediation

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
| G07 | Privacy operations execute the approved request | Privacy recovery: 8 checks passed, including owned exports, corrections and deletion; worker/release checks pending |
| G08 | Privacy legal holds, recovery and restrictions | Privacy recovery passed obligation blocks, interrupted-job recovery, storage revocation and effective restrictions; release checks pending |
| G09 | Customer source links | Source restored; dedicated Customer HTTP/browser recovery verification pending |
| G10 | Atomic exact-variant cart-to-wishlist move | Customer recovery passed selected owned variant movement, replay, stale requests and rollback; release checks pending |
| G11 | Complete scoped wallet history and CSV | Customer recovery passed all owned ledger rows, opening/closing balances and foreign-account exclusion; release checks pending |
| G12 | Customer history pagination and order filters | Customer recovery passed owned order keysets/status filters beyond the old limit; broader history/release checks pending |
| G13 | Customer aftersales history | Aftersales recovery passed owned collection codes and consent progress; broader complete-history/browser verification pending |
| G14 | Address editing and default invariant | Customer recovery passed all-field edits, stale versions and one default under concurrent writes; actual browser create/edit passed; release checks pending |
| G15 | Policy-controlled funded rewards | Funding unit/live and checkout suites passed exact cash/subsidy/refund accounting; independent policy publication passed; release checks pending |
| G16 | Club, market loyalty, refund/chargeback recovery | Loyalty/migration/funding suites passed lineage, debt and market isolation; Club policy publication passed; full UI/release checks pending |
| G17 | Effective notification and privacy preferences | Privacy recovery passed restriction effects on outreach, profiling, AI and push; ordinary preference/browser verification pending |
| G18 | Private sanitized avatars and durable cleanup | Customer recovery passed raster validation, private sanitizing, replacement/deletion and physical cleanup lease/staging recovery; Customer browser avatar flow and Seller HTTP profile/ownership checks passed; worker/release checks pending |
| G19 | Accepted seller team invitations and capabilities | Seller recovery passed exact-recipient acceptance, retained identity and explicit workspace selection; release checks pending |
| G20 | Reviewed affiliate campaign lifecycle | Seller recovery and twelve-stage integration passed independent campaign/application review, attributed purchase and proportional refund reversal; release checks pending |
| G21 | Verified subscription billing and entitlements | Seller recovery passed local provider verification, frozen terms, renewal, expiry and reversal; real Pesapal and release checks pending |
| G22 | Canonical live Super Admin pages | Expanded Super Admin recovery: 10 checks passed covering all 21 destinations, real operations and complete CMS backlog; full browser/release checks pending |
| G23 | Canonical Business procurement lifecycle and Seller B2B | Business recovery and twelve-stage integration passed independent approval, reviewed credit, physical delivery settlement, expiry and recurrence; release checks pending |
| G24 | Canonical Delivery workspace | Delivery recovery: 10 checks passed, including six destinations and desktop/phone Chromium rendering; full UI/release checks pending |
| G25 | Finance exception source drilldown | Expanded Finance reporting suite: 11 checks passed, including all six scoped exception source links and private exports; release checks pending |
| G26 | CMS backlog pagination | Expanded Super Admin suite passed all 67 scoped records through keysets, revision-free lists and versioned older-source edit/stale rejection; release checks pending |
| G27 | Measured Warehouse operational reports | Delivery recovery passed actual task timestamps, 57-record fixture, full keyset CSV and revoked export access; release checks pending |

Evidence was reviewed on 24 October 2026. See the
[recovery checkpoint](2026-10-23-recovery-checkpoint.md) for suite counts,
the saved local logs, mixed-run failures and outstanding verification. Passing
counts include parent tests where applicable. A passed local slice does not
mean its complete release gate passed; no row is marked production complete.

Update this table only from current executable evidence. Commit verified
slices promptly. The twelve-stage integration audit and public 72-case layout
sweep passed. Complete canonical regression, concurrency audit, worker checks,
full browser/accessibility, tested environment installation and final
dependency/security/release gates remain outstanding.
Provider credentials, actual external delivery/payment verification,
independent carrier/credit reviews and production deployment checks must remain
explicit release conditions.
