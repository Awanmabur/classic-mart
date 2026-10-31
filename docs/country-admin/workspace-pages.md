# Country Admin workspace contracts

The 16 approved Final 19 destinations use the existing Node.js 24, Express 5,
EJS and MongoDB modular monolith. The original approved shared assets remain
unchanged. Live partials retain the role layout, four metrics, right-hand aside
and five settings tabs, with scoped additions for actual records and forms.
There is no role selector or Customer dashboard inside the Admin workspace.

| Approved page | Canonical destination | Connected behavior |
| --- | --- | --- |
| Overview | `/admin/overview` | Full scoped backlog, source counts, currency-separated financial evidence and observed Support SLA |
| Seller approvals | `/admin/seller-approvals` | Actual Seller submissions/documents, independent claims, decisions and appeals |
| Promoter approvals | `/admin/promoter-approvals` | Persisted programme submissions, identity/channel/disclosure evidence, claims, decisions and independent appeals |
| Customers | `/admin/customers` | Eligible personal Customer accounts, reasoned suspension/reactivation and session revocation |
| Products | `/admin/products` | Store-scoped catalogue detail, real images/variants/stock, claims and existing product review controls |
| Categories | `/admin/categories` | Categories and `type=brands`, source-aware edits and restrictions across all affected markets |
| Orders | `/admin/orders` | Original orders, matching Seller partitions, shipment proof, payment records and returns |
| Returns | `/admin/returns` | Delivered-line decisions, verified physical receipt, exact warehouse inspection, independent Finance referral, refund or exchange |
| Payments | `/admin/payments` | Source-bound payments, `view=refunds`, `view=events`, Pesapal verification/reconciliation and independent evidence-backed refund completion |
| Coupons | `/admin/coupons` | Real country Coupon creation, editing, availability and checkout redemption controls |
| Campaigns | `/admin/campaigns` | Consent-based messaging and Seller affiliate campaign decisions selected with `tab=affiliate` |
| Reviews | `/admin/reviews` | Actual delivered-purchase sources, independent review claims, publication/rejection and public replies |
| Support | `/admin/support` | Saved requester conversations, ownership, private notes, public replies, transfers, queue/priority and reasoned status changes |
| Content | `/admin/content` | Country homepage slides, press articles and help content; drafts, independent publication, schedules and rollback |
| Reports | `/admin/reports` | Summary, `report=operational` and source-linked `report=audit`, operational calendars and complete scoped CSV |
| Settings | `/admin/settings` | Profile, workspace preferences, market/payment information, notification preferences and security links |

`/admin` resolves the current operator's saved connected landing page, defaulting
to Overview. All 16 `/dashboard/admin-*` aliases use HTTP 308 and retain their
queries. Record selection stays within these destinations. An original order
from Support opens `/admin/orders?country=…&record=…`. Personal security and
messages keep Admin navigation; changing a label or query cannot switch roles.

## Authority and source boundaries

The UI requires the current primary workspace to be Admin and the effective
role to be `country_admin`, backed by exactly one active, unexpired platform
grant. Managed identities may still store Customer as their identity role.
That mirror, a shopping country, submitted role or browser storage cannot grant
administrative privileges. Super Admin, Finance, Support and Moderator accounts
retain their own workspaces. Shared core operations keep their separately
authorized API callers; opening the Admin shell is a stricter boundary.

Current account/token, real web Device, staff grant, verified email/phone,
onboarding, configured authenticator enrollment and active market settings are
checked by `country-admin-workspace-access.js`. State changes use fresh reads
and version fences inside the same transaction as their source records and
required audit evidence. Delegated Finance, Support and Moderation services
receive a server-owned Admin marker and re-enter this boundary inside their
actual transaction. A body/query field cannot choose this marker. Device or
grant revocation and changed primary roles remain effective after an
asynchronous provider call.

Country and currency come from authoritative sources: the owning Store for
catalogue work; the persisted programme submission for Promoters; the original
buyer/order for commerce; and the active country configuration for reporting.
Purchased reviews validate the buyer, delivered order line, Product and Store.
An overlapping product selling-country list does not move its owning Store's
approval work. Global or multi-market changes require authority over every
affected source market. Global approved Brand edits and policy CMS content
remain outside the Country Admin controls.

Explicit versions and saved ownership protect concurrent decisions. Store owners
and relevant staff cannot review their own catalogue. Promoters cannot decide
their own submissions or appeals, and earlier reviewers cannot decide the same
appeal. Customer management excludes platform identities and marketplace staff,
including managed accounts whose stored role is Customer. Suspension and
reactivation both invalidate previous web/mobile sessions; these actions cannot
grant staff roles, change a password or manufacture identity verification.

## Catalogue and marketplace counterparts

Seller verification uses actual uploaded documents and the established Seller
review/appeal workflow. Product approval preserves restricted-product second
review controls and the Seller's separate publication step. Promoter review
uses the information its actual intake collects: identity verification,
programme country, audience/channels and accepted disclosure. It does not
invent uploaded verification documents. A rejected Promoter can submit a real
appeal from their own workspace, preserving the original deciding reviewer.

Category edits preserve markets already used by products and existing product
attribute requirements. Source Product/Store records participate in the edit
transaction. Public catalogue caches are invalidated after successful changes.
Review decisions and replies operate on the same purchased-review records used
by Customers, Sellers and Moderation.

## Physical returns and money

The Orders page is a projection of actual orders and matching Seller partitions,
shipments, payments and returns. It does not offer a button that declares goods
delivered or money paid. A return decision requires a verified original delivery
and the exact reserved delivered order lines. Physical receipt comes from actual
carrier proof or a scoped Warehouse intake with a sanitized receipt image.
Every returned line must complete its own warehouse inspection and recorded
stock disposition before final inspection or a financial outcome.

An inspected refund is referred for independent financial review. Reservation
uses the exact immutable inspected quantity, amount and settlement allocation,
with an idempotency key bound to that return. The inspector and Finance referrer
cannot reserve the same refund. Manual completion requires another operator,
also independent of those earlier actions, with their own ready sanitized
disbursement evidence attached to the exact Return and Refund. The payment
transaction rechecks warehouse tasks, receipt/pickup proof, original order
country/currency and source allocations before writing a balanced ledger refund
and closing that exact return. Wallet refunds credit the original owner's
actual wallet; a submission to Pesapal does not imply completed settlement.

Provider event replay requires a verified event matched to the original Pesapal
payment, order, tracking ID and country, and a current version. Verification and
reconciliation retain actual provider outcomes and failures. Ambiguous refund
submissions require reconciliation rather than blind resubmission. An exchange
uses the existing transactional replacement-order and stock reservation flow.

Private commerce evidence is reauthorized against its current attachment,
Return, original Order and, where applicable, Seller return case. Source fences
and audit save together; dedicated read revisions preserve open form versions
and workflow update dates. Authorization is checked again after the storage
read and before sending bytes.

## Coupons, campaigns and public content

Country Coupons now participate in actual checkout after Seller offers. The
quote checks current market/currency, eligible customer/role, Seller and
category sources, dates, spending thresholds, usage limits, first-order rules
and discount capacity. Both Seller coupon entry points and Country Admin serialize code creation against the same market boundary. Category-restricted Country coupons preserve existing Seller offer shares and attach their own discount only to eligible original order lines; partial refunds use those exact immutable paid shares. Checkout reserves Coupon usage within the order
transaction, serializing account/quota claims and preserving existing Seller
promotion idempotency, price floors and order settlement allocations. Displaying
a Coupon does not reserve it or create an order.

Messaging campaigns queue durable work for the current, consented marketplace
audience in their source country. Scheduling, cancellation and dispatch retain
creator/grant/token provenance. Each delivery rechecks current authority, the
campaign version and the recipient's consent and eligibility. Queued work is
distinct from confirmed delivery; development sinks do not count as live mail.
Seller affiliate campaign decisions validate the actual approved Store, owner,
products and safe assets before changing their public availability.

CMS saves immutable numbered drafts with safe fields and local marketplace
asset URLs. Publication requires an independent administrator, distinct from
both requester and revision author. Approval binds the actual source version,
active public version and revision digest. Scheduled publication rechecks its
recorded approval and current administrative authority. Cancelling a schedule
preserves the current public revision. Rollback requires a previously published
revision and the same independent approval controls. Public homepage, press and
help readers use the resulting approved revision; saving a draft alone does
not change the public page.

## Support, reports and settings

Admin Support works on the same saved tickets and outbox events as staff
Support and the Customer's `/support` page. Handling one's own requester/creator
ticket is forbidden. The claimed owner can reply, add a private note, update
priority/queue, transfer to a currently authorized Support operator, or record a
valid status transition. Public replies appear in the requester's conversation;
private notes and staff metadata are excluded from the Customer projection.
Email dispatch rechecks the actual public message and current sender authority.
The original order must still match requester, country and market currency.

Queues use 25-record keyset pages with complete scoped totals. CSV exports
apply the full filter rather than exporting only the visible page, neutralize
spreadsheet formulas and repeatedly check current authority while honoring
stream backpressure. All-country commerce and Support exports record audit
evidence in each actual authorized market. Reports keep country/currency groups
separate and count financial completion from matched balanced accounting
evidence. SLA percentages use recorded observations and show an unavailable
state when there are none; the UI does not manufacture a perfect score.

Five settings tabs preserve the approved layout. Profile updates change only
allowed personal fields. Saved default country, connected landing page,
reporting period, row density and reminder interval take effect in this
workspace. The idle reminder is a reminder; session security retains its own
server controls. High-risk and appeal/dispute preferences drive real in-app
alerts from validated source transitions and current recipient grants. Market
currencies/calendars, grant coverage, verified contact details and payment
configuration are informative controls, not authority-changing form fields.
Security links use the existing authenticator, password and session workflows.

## Verification and deployment limits

Focused integration coverage is maintained in:

- `test/country-admin-workspace-navigation-live.test.js`
- `test/country-admin-settings-pages-live.test.js`
- `test/country-admin-report-pages-live.test.js`
- `test/country-admin-catalogue-pages-live.test.js`
- `test/country-admin-catalogue-actions-live.test.js`
- `test/country-admin-people-actions-live.test.js`
- `test/country-admin-commerce-pages-live.test.js`
- `test/country-admin-growth-pages-live.test.js`
- `test/country-admin-support-pages-live.test.js`

Cloud verification uses isolated loopback replica-set databases, generated
process-local keys, Chromium and development email/SMS sinks. Production Gmail,
eSMS Africa and Pesapal credentials are not configured in this verification
environment. These checks cannot establish real provider delivery, production
settlement, production load capacity or absolute security. Historical records
missing authoritative source/approval evidence must be reconciled rather than
made valid by fabricated verification flags, receipts or ledger entries.

The approved palette's existing strict contrast limitation remains documented
in [public accessibility](../public-accessibility.md). This stage does not claim
full WCAG compliance or a completed production launch gate. Super Admin,
Business and the full approved Warehouse workspace remain separate stages;
existing Warehouse receipt/task services support the real return workflow here.

## Verification completed on 2026-10-14

After the complete saved installation (`npm ci` with the lockfile and project/import checks), the final 13-file Country Admin group passed all 121 entries with no failures, cancellations or skips. This includes 96 new Country Admin entries across nine suites and 25 existing role/Stage 8/Stage 9/MFA contracts. The affected ten-file Seller, Promoter, Finance, Support and Customer regression group passed all 83 entries. The real Express request-scope regression passed two entries. These groups contain 206 distinct targeted entries; reruns are not added to the count.

All 16 canonical pages, record details and five settings sections were exercised at 1366px and 390px with genuine MFA enrollment/recovery, current staff grants and Device sessions. The shared approved styles, scripts and image assets retain their original identities. The source-detail mobile heading correction is confined to the live Admin partials. The previous public search dropdown repair remains unchanged.

The category-restricted coupon case exercised stacked Seller shares, exact line-specific Country discount snapshots, actual COD checkout, Warehouse pick/pack/dispatch, delivery OTP and sanitized proof, independent reconciliation, physical return receipt/inspection, independent refund and balanced ledger. Other checks cover concurrent claims/code creation, current authorization after asynchronous reads, complete CSV under backpressure, source privacy, saved alerts, public Support replies and required-audit rollback.

The full isolated Stage 1–12 integration audit and native 20-way database concurrency audit passed. Project/import, static security, frontend and functionality gates passed; npm audit reported zero vulnerabilities. Verification MongoDB remained a writable primary with index concurrency one, a 65,536 file limit and zero container restarts. The unused previous Country Admin dashboard loader was removed.

Provider environment variable names were checked without printing values: Gmail SMTP, eSMS Africa and Pesapal credentials were absent. A read-only Pesapal sandbox request was also rejected by the cloud egress proxy (CONNECT HTTP 403); its required hosts (`cybqa.pesapal.com`, `pay.pesapal.com`) and credential names (`PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, `PESAPAL_IPN_ID`) are recorded for environment review. No real provider delivery, production settlement, production migration or deployment ran. Saved setup instructions are separate from publishing or verifying restoration in a fresh cloud task.
