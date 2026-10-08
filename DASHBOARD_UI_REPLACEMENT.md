# Approved dashboard backend checkpoint

This is the Node application from docs.zip, in Awanmabur/classic-mart on the
approved-dashboard-ui branch. It is an unfinished integration checkpoint, not a
production release or a guarantee of complete security.

## Current behavior

The application has no dashboard role selector. Signup assigns Customer on the
server; verified login and completed onboarding land in the account's authorized
dashboard. Browser storage cannot grant a role. Delivery accounts no longer gain
Warehouse administrative access merely through the delivery role.

Email/phone verification and onboarding are enabled by default. SIMPLE_LOGIN=true
is an explicit development-only shortcut, and production startup rejects it.
Logout uses the existing CSRF-protected endpoint and revokes the session device.
Private dashboard responses and metadata prohibit indexing and caching.

The approved Final19 stylesheet, images, icons, card composition and responsive
layout are retained. Customer pages render only the requested page and use
account-scoped records. Their forms and cart/wishlist controls call real services;
the prototype scripts and simulated successes are not loaded for customers.
The header and sidebar show account-specific counts and balances. Server flash
messages report successful submissions and failures. Membership policy cards
use configured country policies rather than unsupported tier benefit promises.

| Customer feature | Current verification |
| --- | --- |
| Signup, login, session renewal, logout, role access | Real MongoDB and HTTP; Chromium signup/logout; development verification delivery |
| Email/phone verification and onboarding | Real development delivery flow with verification enabled; external delivery still pending |
| Addresses | Create, edit, default address, archive, persistence and ownership isolation; browser submission |
| Notifications | Account-scoped records, escaped text, safe links, read state and persistent preferences; local category filters |
| Profile | Persistent edits; unchanged phone no longer triggers verification; changed phone requires verification |
| Wishlist and cart | Real mutations, stock rejection, persistence, cross-account isolation and fresh-login restoration |
| Cart merging | Transactional guest/account merging; one account cart per country across concurrent sessions |
| Rewards | Account ledger and gift-card submission; concurrent redemption credits one claimant; credit failure rolls back card claim |
| Orders, categories, returns, wallet and Club | Account/catalogue/policy data connected; full checkout/delivery/return/refund lifecycle remains to verify |
| Support | Ticket creation, public responses, feedback and reopening persist; internal notes and other accounts' tickets stay private |
| Wallet funding, provider payments and refunds | Existing Pesapal services connected; real provider settlement/callback verification is blocked on credentials |

The other nine workspaces remain development previews. Production dashboard
routes return 503 for these unfinished workspaces instead of presenting sample
records as live operations. Obsolete dashboard templates now delegate to the
approved shell; the unused old AI workspace view was removed. Backend services
are retained for subsequent integration. Do not deploy this checkpoint as a
complete operational marketplace.

The original dashboard-preview/final19 directory remains a design reference.
The standalone npm run dashboard:preview command is a design preview, not the
application or an authentication/payment test.

## Run the application

Use Node 24, npm ci, an actual transaction-capable MongoDB replica set in MONGO_URI,
and the settings in .env.example. Then run npm start. Development log delivery
shows verification codes on the verification pages. That does not verify SMTP or
eSMS Africa delivery. Use your actual account signup; no preview accounts are shipped.

Production configuration is illustrated by .env.production.example. Configure
actual secrets through your deployment's secret settings, not source control.
Production verification and privileged MFA remain required.

## Provider configuration still required

The current workspace has no Pesapal, SMTP or eSMS Africa credentials. Configure sandbox
credentials for provider verification, then live credentials only for release:

- PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_IPN_ID; sandbox verification
  uses PESAPAL_SANDBOX=true and the existing sandbox URL.
- MAIL_MODE=smtp, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM.
- SMS_MODE=esms, ESMS_API_KEY, ESMS_SENDER_ID.

Provider callbacks require a reachable configured BASE_URL and registered IPN.
Production requires live Pesapal configuration. Real mail/SMS delivery, payment
settlement, provider callbacks, reversals and refunds must pass before customer
integration is complete. Seller, promoter, business, warehouse, support,
moderation, finance and administrative dashboard integration, broader performance
validation, public SEO and crawler checks are subsequent work.

## Reproduce focused live verification

Use an isolated local MongoDB replica set with a database name containing test
or verification. These tests create synthetic users and records in that database.
Do not point them at production. Start two development application processes,
one with SIMPLE_LOGIN=true on port 3000 and another with SIMPLE_LOGIN=false on
port 3001. Use MAIL_MODE=log and SMS_MODE=log for these development-only tests.

Set CLASSIC_MART_LIVE_BASE_URL=http://127.0.0.1:3000,
CLASSIC_MART_VERIFIED_BASE_URL=http://127.0.0.1:3001 and
CLASSIC_MART_LIVE_TEST_MONGO_URI to that replica-set URI. Install Chromium with
npm run browser:install, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an installed
Chromium executable. Run npm run test:customer:live. The command refuses missing
settings and nonlocal database/server targets rather than treating skipped tests
as successful verification. It tests actual MongoDB/services, HTTP and Chromium;
it does not verify external providers.

## Verification evidence

Project/import, static security, frontend and functionality checks pass. Focused
live checks pass against MongoDB 8 with replica-set transactions and Chromium.
The historical repository tests were updated for the current approved shell,
role-based landing, retired routes and current media storage/sanitization APIs;
security assertions for authorization, traversal and SVG rejection are retained.
The full repository suite passes: 349 tests, 349 passed, zero failures and zero
skips when the isolated live-test servers, replica-set URI and Chromium executable
are configured. Without live settings, the seven external-process cases are skipped;
that mode alone does not verify the live customer integration. These results do
not certify production integrations or the untested complete commerce lifecycle.

## Messaging security update

Gmail configuration and a no-send SMTP verification command are documented in
[docs/GMAIL_AND_SMS_SETUP.md](docs/GMAIL_AND_SMS_SETUP.md). SMTP now requires
verified TLS. Verification-code consumption and failed-guess accounting are
atomic; failed deliveries invalidate their issued codes. eSMS Africa now has a documented provider adapter.
Live eSMS receipt and Gmail authentication remain unverified without account credentials.

### eSMS Africa adapter

Implemented from the provider SDK contract: bearer-authenticated HTTPS sending,
strict response validation, timeout and redirect protection, optional approved
sender ID, and a no-send balance/authentication check (`npm run sms:verify`).
Production accepts a live eSMS key. See
[configuration instructions](docs/GMAIL_AND_SMS_SETUP.md). No live provider credentials
are present here, so actual SMS receipt and Gmail authentication remain unverified.

Adapter checkpoint validation: all 353 tests passed with zero failures or skips
using the local MongoDB replica set, both authentication servers, and Chromium.
Project checks, security checks, and frontend audit passed.

### Easier signup

Signup now verifies email only before onboarding and dashboard access. Phone
verification remains optional from the profile page. The signup phone field has
an accessible country-code selector using configured active countries; composition
and prefix validation happen on the server. Production can leave SMS disabled
until credentials are available, without development-code fallback. The live
signup test verifies dashboard access before optional phone verification.

### Remove remaining customer dashboard chrome

Removed the entire workspace-label field from the deployed header, including the
JavaScript that recreated it. Search occupies the available space between brand
and actions. Approved base styles remain identical to Final 19; the session layer
only handles the requested header change and equivalent button/link presentation.

Legacy customer profile/order entry points redirect to approved pages. Security,
messages, privacy, rewards, buyer protection/returns and connected apps now use
the approved shell, with their real forms and account ownership checks retained
in reviewed server partials. Those customer templates no longer load account.css
or the old account header/nav. Operational specialist tools outside these customer
paths remain a separate migration task; this checkpoint does not claim every
operational form has been rebuilt or every role is backend-connected.

Validation: all 355 tests passed, zero skips; project/security/frontend checks
passed. Chromium checked ten customer/account paths for the approved shell,
visible search, absence of the workspace field and absence of old account chrome.
Desktop and mobile screenshots were inspected after transitions settled.

### Retired UI removal

Deleted all 37 dashboard compatibility/legacy templates, both duplicate dashboard
asset folders, the old account stylesheet, old account header/nav partials, and the
unused source-layout renderer. Server render calls now target the approved shell
directly. The active staff-invitation form is a reviewed approved-shell partial.
Business documents retain their printable document layout and use approved assets.
The approved Final 19 design source and deployed approved dashboard assets remain.

The service-worker cache version advances to clear previously cached files, and
private dashboard paths explicitly bypass its cache. A concurrent startup/signup
failure exposed by verification was fixed by sharing an executed feature-query
Promise rather than reusing a Mongoose query thenable.

This removes the retired UI from the current project tree, not Git history. Backend
services and authorization checks remain; unfinished operational backend wiring is
still gated in production. Cleanup checks require absent retired files and valid
literal server-render targets so stale UI cannot silently return.

Removal verification: all 359 tests passed with zero failures or skips; project,
security and frontend checks passed. Retired asset URLs return HTTP 404 directly.
Ten authenticated customer/account paths passed the browser check.

## Customer page layout and navigation corrections

Customer sidebar links now open clean server routes such as `/dashboard/addresses`
and `/dashboard/rewards`. Customer initialization removes old page fragments;
within-page links scroll without adding a fragment to the URL.

My Orders restores the approved All, Processing, Shipped and Delivered tabs.
Filters use the customer's database-backed fulfillment states, including partial
shipping/delivery, and display an empty state when a selected status has no rows.

Addresses restores the approved Region, optional Postal code and address-type
selector. Region and postal code persist in MongoDB and populate the edit form;
existing custom address labels remain editable. Rewards forms, points typography,
account headings, Password & Security panels, button alignment and checkbox sizing
now follow the approved dashboard styling. The original three Final19 base CSS
files remain unchanged; corrections are scoped in the approved session stylesheet.

Verification: all 360 tests passed with zero failures or skips, including real
MongoDB address persistence and Chromium order-filter tests. Project, security
and frontend checks passed. All 13 customer pages and Password & Security were
checked in Chromium at desktop (1366px) and mobile (390px) widths for clean URLs,
button styling and horizontal overflow.

## Canonical routes and foundation hardening

Customer pages now use `/dashboard`, `/orders`, `/addresses`, `/rewards`,
`/categories` and the other short paths. Old customer page URLs redirect;
protected legacy form submissions remain compatible. The approved base UI
stylesheets remain byte-for-byte unchanged.

See [customer foundation verification](docs/performance/customer-foundation.md)
for route boundaries, query/index changes, private-cache safeguards, dependency
patches, public crawler discovery and measured local results. Updating this
checkpoint requires `npm ci` followed by a server restart.

### Seller store-settings integration

Seller login and onboarding now land at `/seller/store`. Store identity and
operating preferences persist through the approved UI with country-aware phone
validation, store permissions, MFA gating, stale-edit checks and transactional
audit evidence. Other seller dashboard pages remain disabled until their own
workflows are connected and verified. See the [seller milestone](docs/seller/store-settings.md)
for completed behavior, test evidence and remaining scope.

### Seller verification and independent review

Seller verification now works at `/seller/verification`, including private
uploads, submission, rejection reasons, appeals and final approval. Moderators
review their assigned countries at `/moderation/verifications`. Document and
identifier encryption, current-evidence checks, independent reviewers, exclusive
claims, transactional audit/notifications and desktop/mobile browser checks cover
this flow. See the [verification milestone](docs/seller/verification.md) for test
evidence, provider limits and remaining work.

### Phone country selector and eSMS-only configuration

Signup and seller support phone selectors now use library-generated calling codes
and international country names, with the calling code first and the approved
rounded dropdown style. The only external SMS adapter and deployment configuration
is eSMS Africa. An API key selects that adapter automatically when SMS_MODE is
omitted; log mode explicitly reports that no SMS was sent. See
[SMS configuration and verification](docs/production/SMS.md) for safe configuration,
provider diagnostics and live-delivery limits.
