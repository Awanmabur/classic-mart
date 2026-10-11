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
`/seller/store`; products, orders and shipping have their own protected routes.
The overview reads actual store sales, orders, catalogue, review and team data.
Unconnected Seller sections remain unavailable instead of showing preview data.

An account may also buy from the marketplace. Explicit shopping routes show
that identity's own purchases within its authorized workspace layout; they do
not change its primary workspace. Seller navigation points to Seller operational
routes, while personal purchases remain separate from store fulfilment.

## Verification

Role landing tests exercise real login, session regeneration and route access.
Isolated MongoDB tests exercise signup, enrollment, store membership, MFA,
tenant isolation and Seller reporting. Chromium tests check actual forms and
Seller navigation at desktop and mobile sizes. Development mail/SMS sinks
keep these checks separate from real provider delivery.
