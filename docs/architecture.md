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

## Verification

Role landing tests exercise real login, session regeneration and route access.
Isolated MongoDB tests exercise signup, enrollment, store membership, MFA,
tenant isolation and Seller reporting. Chromium tests check actual forms and
Seller navigation at desktop and mobile sizes. Development mail/SMS sinks
keep these checks separate from real provider delivery.
