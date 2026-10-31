# Moderation workspace contracts

The eight approved Final 19 pages use the existing Express/EJS modular monolith.
Their original shared styles, scripts and images are unchanged. Scoped live
partials render actual records, controls and empty states. There is no role
selector, demo success state or customer dashboard inside the Moderator shell.

| Approved page | Canonical destination | Connected behavior |
| --- | --- | --- |
| Overview | `/moderation/overview` | Complete source-verified backlog, recent activity, observed quality and operational scope |
| Product review | `/moderation/products` | Filtered/keyset queue, actual product details/images/stock, independent claim/release/decision |
| Reviews | `/moderation/reviews` | Delivered purchase review sources, publication/rejection and Seller dispute handling |
| Seller verification | `/moderation/verifications` | Actual required uploaded documents, masked identifiers, independent claims/decisions and appeals |
| Risk cases | `/moderation/risk-cases` | Customer concerns, Support/QA referrals and recorded risk signals selected with `kind=signals` |
| Audit | `/moderation/audit` | Source-verified audit targets, filters/keysets and private CSV |
| Reports | `/moderation/reports` | Summary, recorded decisions and independent QA with complete scoped totals/CSV |
| Settings | `/moderation/settings` | Five approved tabs, real profile/preferences/alert controls and immutable market/security information |

`/moderation` redirects to the operator's current saved landing page, defaulting
to Overview. All eight `/dashboard/moderator-*` aliases use HTTP 308 and retain
their queries. Product and verification detail URLs remain within the same
eight-page shell. Personal security and messages retain Moderator navigation.

## Authorization and changes

The primary workspace must currently be Moderator. A managed account requires
exactly one active, unexpired authoritative platform grant. The persisted
Customer identity mirror, shopping country, submitted role and browser storage
cannot choose operational privileges or data. Admin/Super Admin permissions do
not open this UI; their existing core review functions retain separately scoped
administrative authorization.

Verified identity, onboarding and configured authenticator enrollment protect
operational routes. Every current request validates account/token, Device,
grant and active market configuration. Long reads and exports recheck access.
Mutations use transaction-aware account, Device, grant and market version fences
alongside source-record version fences. Revocation, target changes and failed
required audit/notification writes abort the affected transaction.

Queues use bounded keyset pages with complete totals. Catalogue country comes
from the actual owning Store, not a product's overlapping selling countries.
Reviews join the original buyer, delivered order line, Product and Store. Cases
and signals join their actual subjects. Forged labels, orphan references and
foreign sources are excluded; selected out-of-scope records do not disclose
private detail.

Claims and explicit saved versions arbitrate concurrent decisions. Store owners
and active or invited staff cannot review their own products or verification.
Affected buyers, reporters, Seller disputers and earlier appeal decision makers
cannot decide their own concerns. Restricted products require two independent
approvals; the Seller must then actually publish the approved listing. Media
approval alone does not publish a product.

## Customer and Seller counterparts

Verified reviews require an actual owned delivered purchase and prevent store
self-review. A Seller dispute uses the same source-verified record, clears a
previous assignment and requests independent review. Customer product/store
reports validate their actual subject and market. Owned replies and one allowed
appeal preserve the original public decision and require a different reviewer.
Safe customer projections expose public messages and outcomes without staff
notes, internal actor identifiers or provider data. QA referrals cannot use
customer reply/appeal endpoints.

Support review referrals retain their actual ticket, review, order and attached
evidence links. Private evidence must be ready, attached to the matching case
and owned by its actual reporter. File handlers recheck current authorization
after storage I/O. Verification documents remain encrypted at rest and rendered
through private, audited routes; identifiers are masked in Moderator details.

Risk decisions record a reason and history atomically. Destructive global
Product/Store enforcement requires authority over every affected selling market.
Restoration validates the recorded original state instead of turning an
unverified store or unapproved product into a published listing.

## Reports, QA and settings

Reports use assigned countries and their operational calendars. They count all
matching records, not the first visible page. Observed decision quality is absent
when no verified independent QA outcome exists. Pending QA validates an immutable
decision version/time/reviewer and the original source history. Its original
reviewer and affected store staff cannot claim or complete that QA. Uphold,
coaching and escalation outcomes require a current claim/version and atomic
audit. Escalation creates one durable trust case linked to the QA and original
Product/Store, rather than an inert flag or simulated notification.

CSV uses bounded pages, safe spreadsheet cells, stream backpressure and current
authorization checks before each data row. Report export audits follow the
reporting snapshot: the newly recorded export itself appears in later reports.
Private contacts, storage keys and document bytes are excluded from exports.

Settings persist actual profile fields, assigned default country, reporting
period, one of eight landing pages, comfortable/compact density, inactivity
reminder and priority/escalation alert choices. Those choices drive the real
workspace behavior and scoped work alerts. Market policy, money configuration,
role and country grants remain server controlled. Five tabs preserve the
approved UI without inventing editable payment/business policy or a weekly
delivery feature.

## Validation and deployment limits

Verified in the isolated cloud environment on 2026-10-13 (Africa/Kampala):

- The complete saved installation script passed with Node.js 24, frozen-lockfile
  `npm ci`, project/import checks and regenerated ignored verification helpers.
- The post-install eight-file Moderation/role/source-contract group passed all
  **93 tests**, with zero failures, cancellations or skips. This includes all
  **74 new Moderation tests** across the five focused files and 19 existing role,
  Stage 8 and MFA contracts. Reruns are not added to these counts.
- All eight canonical pages, their Product/verification detail shells and all
  five settings tabs passed authenticated Chromium checks at 1366px and 390px.
  Original base asset checks, real MFA enrollment/recovery, current grants,
  market scopes, target claims, rollback, private-file revocation, Customer
  appeals/replies and Seller disputes/public conversations passed.
- The selected seven-file Customer/Seller/Support/effective-role regression
  group passed **41 tests**, with no failures or skips.
- The additional Customer design/backend/read-cache contract group passed
  **21 tests**, with no failures or skips. These are contract and cache checks,
  rather than a production load benchmark.
- Full Stage 1–12 isolated integration and native 20-way database concurrency
  audits passed. Project/import, static security, frontend and functionality
  gates passed; `npm audit` reported zero vulnerabilities. Verification MongoDB
  remained a writable primary with zero container restarts.

Focused integration coverage is in:

- `test/moderation-catalogue-pages-live.test.js`
- `test/moderation-trust-pages-live.test.js`
- `test/moderation-report-pages-live.test.js`
- `test/moderation-settings-pages-live.test.js`
- `test/moderation-workspace-navigation-live.test.js`

The cloud verification workflow uses only isolated loopback replica-set test
databases, generated process-local keys, Chromium and development mail/SMS sinks.
It does not migrate a production database or verify real provider settlement.
Real Gmail, eSMS Africa and Pesapal credentials must be configured separately.
The existing approved-palette contrast limitation remains documented in
`docs/public-accessibility.md`; preserving this UI is not a claim of full WCAG
compliance, production load certification, a passing complete release gate or
absolute security. Other uncompleted workspace stages remain separate work.
