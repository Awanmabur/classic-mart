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
Twilio delivery. Use your actual account signup; no preview accounts are shipped.

Production configuration is illustrated by .env.production.example. Configure
actual secrets through your deployment's secret settings, not source control.
Production verification and privileged MFA remain required.

## Provider configuration still required

The current workspace has no Pesapal, SMTP or Twilio credentials. Configure sandbox
credentials for provider verification, then live credentials only for release:

- PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_IPN_ID; sandbox verification
  uses PESAPAL_SANDBOX=true and the existing sandbox URL.
- MAIL_MODE=smtp, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM.
- SMS_MODE=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.

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
The full repository suite passes: 345 tests, 345 passed, zero failures and zero
skips when the isolated live-test servers, replica-set URI and Chromium executable
are configured. Without live settings, the six external-process cases are skipped;
that mode alone does not verify the live customer integration. These results do
not certify production integrations or the untested complete commerce lifecycle.
