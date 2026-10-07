# Approved dashboard UI replacement

This change applies to the Node.js application from the supplied docs.zip.
The separate static classicmart Git checkout is unchanged.

## Current behavior

- Successful email/password login opens the account's primary authorized workspace.
- The ten Final 19 workspaces and all 123 pages use the supplied preview UI.
- Delivery users land in the Warehouse workspace, matching the existing role mapping.
- Explicit safe local next destinations still work.
- Existing authentication, session regeneration, CSRF, account status, authorization grants,
  and configured verification/MFA checks remain in place.
- Workspace choices are limited to the account's authorized workspaces. Server routes
  reject unauthorized pages; browser storage does not grant access.
- Logout submits to the existing CSRF-protected session logout endpoint.
- Fonts, CSS, scripts, illustrations, layout, sample names, and sample metrics remain
  the approved preview. Dashboard forms/data are still frontend demonstrations;
  they are not connected to live orders, wallet, payments, inventory, or support.

The original preview in dashboard-preview/final19 is unchanged. Its stylesheet,
JavaScript, and image files are deployed byte-for-byte in public/approved-dashboard.
The EJS shell only adds absolute asset paths and session/navigation adapters.
Old dashboard layout partials and runtime/bridge files were removed; old dashboard
view names now delegate to the approved shell for route compatibility.
Existing backend services and independent account/commerce pages are retained.

## Run

Use Node 24. Run npm ci and npm start in this application's root directory.
The existing application requires a transaction-capable MongoDB connection in
MONGO_URI and its normal environment configuration. Do not replace real login with
preview accounts. Enter credentials through your normal secure configuration.
For the original standalone design preview only: npm run dashboard:preview.

## Verification

- npm run check: passed.
- npm run frontend:audit: passed.
- node --test test/approved-dashboard.test.js test/app.test.js test/roles.test.js
  test/privileged-mfa-navigation.test.js: 18 tests passed.
- Tests cover real password verification and login/session routes with database
  adapter fixtures, all assigned role landings, all 123 dashboard pages,
  unauthorized access, missing pages, logout, unsafe redirects, and asset identity.
- Chromium checks cover ten workspace landings, asset loading, JavaScript errors,
  customer navigation, mobile layout, workspace switching, and logout.

No live MongoDB credentials are configured in this workspace. Database fixtures
are used only by tests and the temporary external browser test harness; no fixture
server or test account is shipped as an application login feature.
Live database login and end-to-end dashboard data are not claimed as verified.
The historical full release/backend suite was not run for this UI checkpoint.
