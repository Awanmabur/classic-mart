# Public storefront accessibility and browser verification

The initial 2026-10-08 milestone follows the seller product lifecycle integration. It fixes the
public-site accessibility failures recorded in [seller/products.md](seller/products.md).
The approved dashboard template, reference markup and dashboard stylesheets are
unchanged at that checkpoint. The later approved-design restoration and its
current accessibility findings are recorded below; historical passing results
do not apply to the restored palette.

## User-visible behaviour

Product cards keep their existing layout and pointer preview behaviour. Native
buttons in their headings provide keyboard preview activation without nesting
cart and wishlist buttons inside another button. Anonymous wishlist actions
redirect to sign-in before attempting a protected mutation.

The homepage search field exposes a combobox with labelled options, arrow-key
selection, Enter to open a preview and Escape to dismiss suggestions. Other
pages expose a regular search field. Filter and product dialogs keep keyboard
focus inside while open, exclude closed controls from navigation and restore
focus to the opener. Delayed product responses cannot reopen a dismissed preview
or replace a newer selection.

Inactive hero slides are hidden from assistive technology and cannot receive
focus. Arrows, dots and touch gestures select slides manually; promotional cards
have one brief entry motion. Reduced-motion preferences suppress motion. Hero
dots retain their visible shapes with larger touch targets.

Public controls and small text use contrast-safe shades of the existing colour
palette. Dark banners retain lighter accents. Keyboard focus has a visible
outline, including catalogue search, price and sorting controls. At 320 CSS
pixels the deals banner stacks its countdown without page-level overflow.
The public service-worker cache advances to v29 so existing installations
refresh the affected scripts and styles.

## Reproducing the browser checks

Use Node 24, `npm ci`, an isolated MongoDB replica set and the development mail/SMS
sinks. Generate a fresh, strong `ADMIN_PASSWORD` in the process environment and
seed a fresh test database with an explicit synthetic `ADMIN_EMAIL` and valid
`ADMIN_PHONE`; do not reuse a production database or account. The seed preserves
an existing account's password, so changing the environment alone will not reset
an already seeded account.

For local test startup, set `NODE_ENV=test`, `CLASSIC_MART_TEST_MONGO_OVERRIDE=1`
and `MONGO_URI` to that isolated database before running `node scripts/seed.js`
and `npm start`. `MAIL_MODE=log` and `SMS_MODE=log` avoid provider calls. Keep the
same environment and browser fixture credentials for the browser gate.

Install Chromium with `npm run browser:install`, or point
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` at an installed Chromium executable. Both desktop
and mobile projects explicitly use Chromium; the iPhone viewport does not select
the WebKit protocol. `E2E_BASE_URL` selects the running test app.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
E2E_VIDEO=off \
npm run browser:check
```

Video capture defaults to `retain-on-failure`. `E2E_VIDEO=off` is an explicit
option for environments without Playwright's video encoder; screenshots and
traces remain available. The cloud verification used system Chromium and this
option because the official encoder download was unavailable.

GitHub CI uses an ephemeral masked password and explicit synthetic account
identifiers for seeding and browser authentication. Generated browser reports,
screenshots and traces are ignored by Git and uploaded as CI diagnostics.

## Verification scope

Verified on 2026-10-08: **381 canonical tests passed with zero failures and zero
skips**. The desktop/mobile browser gate passed **50 checks with zero failures**;
four additional cases are intentional project-specific skips. All authenticated
cases applicable to their project ran with the seeded test account. The updated
source contracts also passed their targeted 65-test run.

Project/import, security, frontend and functionality gates passed. MongoDB
replica-set verification, the stages 1–12 financial integration audit and the
20-way concurrency audit passed; migration planning completed without applying
changes. The dependency audit reported zero vulnerabilities. Additional opened
Share-menu hover scans passed on desktop and mobile. CI YAML parses and its
database-dependent steps explicitly enable the isolated test database override.

The browser gate checks successful HTTP responses and expected content on home,
products, search, categories, sign-in, sign-up, privacy and terms. It scans WCAG
A/AA rules with axe, including open previews, suggestions, filters and manually
selected hero slides. It also exercises native keyboard focus, narrow reflow,
reduced motion, touch targets, server-persisted guest cart changes, search and
history navigation, seller product forms, moderation access and labelled seller
tables on phones. Delayed-response cases hold and release actual server responses
to verify preview cancellation and selection ordering.

The four project-specific skips avoid duplicating desktop-only operational
navigation and mobile-only layout assertions in the opposite project. Supplying
the seeded fixture credentials is required to execute authenticated coverage.

These automated checks cover the listed routes and states. They are not a manual
screen-reader audit or a site-wide accessibility certification. No real Gmail,
eSMS or Pesapal delivery/payment calls are made by these tests. The remaining
role-dashboard integrations and live provider verification retain their separate
release requirements.

## Approved public UI correction

The final 2026-10-09 correction restores the uploaded application's original
foregrounds as well as its backgrounds. White button labels and icons, orange
branding, hero/newsletter copy, prices, stars, badges, muted text and hover
colours match the approved source. The original slider-dot geometry and
authentication-link decoration are also restored. Card dimensions, pill
shapes, page structure and typography remain the approved design.
Keyboard navigation, focus indicators, dialog containment, native product
actions and delayed-response protections remain enabled.

Promotional cards explicitly establish their image-positioning container.
Mobile images remain inside their own cards when reduced motion is enabled or
entry animations have finished, rather than overlapping adjacent cards and
shopping benefits. Browser regressions verify 320/390-pixel containment and the
rendered original public colours, including white action labels. The public
service-worker cache advances to v31 to refresh existing installations.

Reference comparisons check the uploaded ZIP on the same live DOM. Ninety
rendered colour comparisons across home, products, about, contact, help, login
and seller signup matched at 390 and 1366 pixels. Existing colour declarations
in all five affected stylesheets match the original source. Source comparisons
also preserve home/catalog geometry. Catalog loading captures match exactly;
home captures retain small differences from native controls, motion and image
containment fixes and are not claimed to be pixel-identical.

The targeted brand/containment browser regression passed four checks. The
separate seller account-entry regression passed eleven real MongoDB/browser
checks, including verification, MFA and account re-entry. Customer profile
behaviour remains unchanged; sellers' generic profile entry opens their seller
workspace. On small screens the dashboard search retains the approved fixed
10-pixel insets without clipping its action button.

Strict accessibility scans remain enabled. Restoring the original approved
palette restores its contrast findings: small white labels on bright orange
have about 2.95:1 contrast, below the AA requirement of 4.5:1. Original slider
dots also trigger target-size findings. Scans of nine public pages at desktop
and mobile widths reported those two rule types, without other violations in
those scanned states. The existing strict WCAG tests intentionally still fail
these findings; no audit rules or assertions were suppressed. This correction
does not claim AA compliance or a passing complete release gate.

The broader run recorded 429 passing tests and six failed results: the
enrolment contrast assertion and its parent result, three stale source
contracts, and a warehouse test interrupted by a fatal restart of the isolated
MongoDB server. The affected account/source checks subsequently passed their
20-test run; warehouse operations subsequently passed ten checks with no
failures or skips. The strict enrolment contrast assertion remains failing.
Critical desktop/mobile browser flows passed thirteen checks with three
intentional project-specific skips. Project/import, security, frontend and
functionality checks passed. No real messaging or payment provider calls were
made, and the complete strict suite is not reported as passing.
