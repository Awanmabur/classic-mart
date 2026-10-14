# Application architecture

Classic Mart is a modular monolith: one Node.js/Express application, with EJS
pages rendered on the server and MongoDB accessed through Mongoose. Redis is
optional infrastructure for shared caching and related runtime services. The
dashboard is not a separate frontend application.

Routes validate requests and enforce access. Services implement marketplace
rules and persistence. Dashboard view builders supply scoped data and
navigation to the shared approved layout; EJS partials render the appropriate
workspace content. Sharing a layout does not grant access to another role's
data or operations.

## Identity and workspace boundaries

- `src/middleware/auth.js` reloads the active user and device, validates the
  session's token version, and hydrates current platform authorization.
- `src/dashboard/access.js` chooses authorized workspaces from current roles,
  permissions and active grants. `src/dashboard/landing.js` selects the primary
  dashboard after login and at generic account entry points.
- Seller operations additionally load the selected store and require a current
  membership with the capability needed by the operation. Data queries restrict
  store, country and currency where relevant.
- Personal security, privacy, messages, notifications and connected apps remain
  scoped to the signed-in identity. Their surrounding workspace navigation is
  chosen separately, so a Seller configuring personal security retains the
  Seller layout. Reading these account pages does not create a store or change
  an account's role.
- Privileged operational routes require authenticator enrollment when enabled
  in configuration. Enrollment is a security step before entering that
  workspace, rather than a change of account type. A validated continuation
  retains the requested destination through setup; recovery codes are shown
  before the user continues.

## Seller entry points

`/seller/overview` is the Seller landing page. Store configuration remains at
`/seller/store`. All 17 approved Seller navigation destinations have canonical
`/seller/...` routes and read store-scoped records. Catalogue, fulfilment,
inventory, support, growth, finance and analytics each require their own current
membership capability. Invited staff must meet the same verification and
configured MFA requirements as store owners. Legacy `/dashboard/seller-*`
links redirect to canonical pages while preserving their query parameters.

Page services project safe view data into the approved EJS layout. Empty stores
show empty records and real zero totals. Stock writes use transactions and
version checks; warehouse archive races with receipts and task creation cannot
leave stock or work assigned to an archived location. Payouts use the store's
ledger balance and verified payout destination. Submission does not simulate
provider settlement. Subscription changes remain approval requests until the
existing independent approval and payment process completes. See the
[Seller page contracts](seller/workspace-pages.md) for routes and operations.

An account may also buy from the marketplace. Explicit shopping routes show
that identity's own purchases within its authorized workspace layout; they do
not change its primary workspace. Seller navigation points to Seller operational
routes, while personal purchases remain separate from store fulfilment.

## Promoter entry points

`/promoter/overview` is the Promoter landing page. All 15 approved destinations
use canonical `/promoter/...` routes and live services. The account's current
literal Promoter role and primary workspace must both authorize access; a
different role or platform grant cannot silently become a Promoter. Personal
security and messages retain Promoter navigation. See the
[Promoter page contracts](promoter/workspace-pages.md).

Programme country comes from the persisted verification record, falling back
to the registration country, and currency/time zone come from its active country
configuration. Shopping preferences do not select programme funds. Public links
and checkout recheck current campaign, merchant, product and programme access.
Checkout attribution participates in the order transaction. Pending commission
estimates become ledger funds only through verified payment; payout reservations
and commission settlement retain country and currency scope.

Reusable referral invitations have separate signup receipts, preserving the
legacy receipt indexes. Campaign messages allow the accepted Promoter and the
current Seller owner to reply to the same persisted conversation. Ordinary
conversation alerts honor the Promoter's communication preference.

## Finance entry points

`/finance/overview` is the default Finance landing page; operators may choose
another of the nine connected Finance queues in their saved settings. Canonical
routes use `/finance/...` and legacy `/dashboard/finance-*` URLs redirect.
The current primary workspace controls the UI independently of the identity's
stored role mirror. An active staff grant can authorize Finance while the
underlying account still stores Customer. Admin/Super Admin money permissions
remain scoped to their own API workflows and do not open the Finance UI.

Financial services use fresh, transaction-aware account/grant/market fences,
immutable source references, independent operator decisions and atomic audit.
Country/currency totals are kept separate; shopping preferences do not move
operational money. Pages and long exports stop when current authorization or
market changes. Refunds, payouts, COD and disputes retain real ledger accounting
and explicit provider/manual evidence. Weekly report settings drive the actual
maintenance/outbox job with idempotent scheduling and fresh delivery checks.
See the [Finance page contracts](finance/workspace-pages.md) for the nine pages,
operator boundaries, migration precautions and validation limits.

## Support entry points

`/support/overview` is the primary Support landing page; `/support` retains the
customer's shopping help page. All nine canonical staff destinations preserve
the approved role layout. A current Support grant determines the workspace even
when the stored identity role is Customer. Other primary staff roles cannot
render Support pages through aliases or query parameters.

Ticket, case, commerce context, report and settings services provide explicit
scoped projections. Customer projections exclude private notes and staff/payment
metadata. Contact disclosure requires an assigned active case and rechecks the
recipient, order, scope and case version after page loading. Customer appeals
retain the original public decision and require an independent reviewer.

Warehouse receipts and actual inspection tasks establish physical goods custody.
Support refers inspected immutable amounts to Finance; refund reservation and
completion bind and close the exact return within the accounting transaction.
Saved notification preferences drive scoped alerts and the real weekly report
maintenance/outbox job. Long CSV exports recheck authorization and honor stream
backpressure. See the [Support contracts](support/workspace-pages.md) for actual
routes, rollout precautions, responsive verification and remaining limits.

## Moderation entry points

`/moderation/overview` is the default landing page. All eight approved
destinations use canonical `/moderation/...` routes; `/dashboard/moderator-*`
aliases preserve their queries. Saved settings can select another connected
landing page. A current Moderator grant controls the workspace even when the
stored identity role is Customer. Other primary workspaces, including Admin and
Super Admin, cannot render this UI. Existing administrative decision services
retain their own permission boundaries.

`moderation-workspace-access.js` rereads the account, current device, grant and
active market configuration. Mutations fence those records and the affected
source records within their database transaction. Decisions require current
versions, an independent claimed reviewer and atomic audit evidence. Store
owners and active or invited staff cannot review their own catalogue; buyers,
reporters and disputers cannot decide their own concerns. Restricted product
approval and customer appeals require a different deciding reviewer.

Catalogue queues use the owning Store country. Purchased reviews validate the
actual buyer, delivered order line, Product and Store. Trust cases and signals
validate their actual subjects instead of trusting a country label. Global
product/store enforcement requires authority over every affected market and
restoration retains the recorded prior state. Independent QA validates the
original saved decision and history; escalations create a durable linked trust
case. Source-verified reports count the full scope, and CSV exports use bounded
pages, stream backpressure and repeated authorization checks. Private evidence
is reauthorized after storage reads and before sending bytes. See the
[Moderation contracts](moderation/workspace-pages.md) for routes, tests and
remaining deployment limits.

## Country Admin entry points

`/admin/overview` is the default landing page for the 16 approved Country Admin
destinations. `/admin` follows the operator's saved connected landing preference;
legacy `/dashboard/admin-*` aliases retain queries. The current effective
`country_admin` role, primary Admin workspace and one active authoritative staff
grant determine access. Verified staff identity, current Device/token,
onboarding and configured authenticator enrollment are checked again in live
services. Other primary workspaces, including Super Admin, do not render this UI.

Six domains connect catalogue/people, commerce, growth/content, Support, reports
and settings to actual source records. Shared core operations retain their own
authorized callers; server-owned delegation re-enters the strict Admin boundary
inside the actual transaction. Account, Device, grant, market and target fences
save with required audit evidence. The owning Store, persisted programme or
original Order determines operational country. Global and multi-market changes
require coverage of all affected sources; shopping preferences do not move work
or funds.

Country Coupons participate in checkout's actual quote, usage reservation and
settlement allocation after Seller offers. Messaging campaigns use durable
outbox work and fresh consent/creator checks at delivery. Public homepage, press
and help revisions require independent source-bound CMS approval, including
scheduled publication and rollback. Physical return inspection and independent
refund controls reuse actual Warehouse tasks, immutable Order allocations,
sanitized disbursement evidence and balanced accounting. Admin Support replies
reach the same Customer conversation at `/support` while private notes stay
with authorized staff.

Queues use 25-record keysets, full scoped totals and authorization-aware streamed
CSV. Reports preserve separate country/currency groups and use source accounting
and observed Support SLA rather than synthetic outcomes. Five settings tabs
save allowed profile/preferences and control actual in-app work alerts. See the
[Country Admin contracts](country-admin/workspace-pages.md) for all routes,
counterparts, source controls and deployment limits. Super Admin, Business and
the full approved Warehouse workspace continue through separate stages.

## Verification

Role landing tests exercise real login, session regeneration and route access.
Isolated MongoDB tests exercise signup, enrollment, store membership, MFA,
tenant isolation and Seller reporting. Chromium tests check actual forms and
Seller navigation at desktop and mobile sizes. Development mail/SMS sinks
keep these checks separate from real provider delivery.
