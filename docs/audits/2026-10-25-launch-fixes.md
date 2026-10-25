# Launch fixes — 25 October 2026

This change prepares the current recovery work for `master`. It fixes the reported
administrator setup and notification problems and provides the launch handoff.
It does not certify live delivery, deployment readiness or the approved palette's
remaining contrast failures.

## Reported failures and corrections

The supplied `f83685e6-e998-484b-b06e-a4db7dc27b28` log records a real
MongoDB session-store server-selection failure: an Atlas hostname could not be
resolved. The session store already shares the application's MongoClient. There
was no separate connection pool to replace. Genuine MongoDB selection/network
outages now return a private, safe `503 DATABASE_UNAVAILABLE` response with a
request ID and `Retry-After: 30`, rather than a generic 500. The host still needs
working DNS/network access and a current Atlas connection string. No database,
collection, session or customer record was erased to hide that failure.

Redis startup previously logged every refused TCP attempt. Development now
settles after one attempt, reports the outage once and applies a bounded retry
cooldown. Production startup still requires Redis. After a successful connection,
sessions and shared limits retain the same reconnecting client; offline commands
reject instead of queuing authenticated work. Restoring Redis preserves the
stored session and security counters. Ordinary cancelled product-image downloads
are debug diagnostics; actual failures remain visible. A partial response failure
closes the stream after one sanitized diagnostic instead of invoking a raw-stack
default handler.

The Super Admin 403 occurred because the service requires verified identity and
MFA even when development login skips the global setup redirect. A current global
grant now receives the appropriate HTML setup destination. JSON/service access
remains closed until verification and actual enrollment finish. Authenticator
enrollment preserves the Super Admin shell, recovery-code display and validated
continuation; operational access cannot disable its required factor.

Marketplace action text is centered on the error page. Server messages and client
notifications share one primary-colour full-border component. Add-to-cart,
newsletter, search, wishlist and dashboard errors use the same safe text-based
surface. Duplicate account messages, competing toast styles and the old left
accent are removed. The component supports dismissal, live announcements and
keyboard reading without stealing focus.

## Yoola and launch configuration

Yoola replaces the previous SMS adapter. The request contract comes from this
owner's existing `chariot-sms-test` integration, pinned to commit
`e694237edf03c2445c722f1f4b3bf5801a2740d2`; it is not independently retrieved
official provider documentation. See [SMS setup](../production/SMS.md) for exact
endpoints, response rules and verification limits. Configure `SMS_MODE=yoola`
and `YOOLA_API_KEY`; the account's default sender is used. Sends have no automatic
retry or redirect, use bounded responses and expire after ten seconds. An explicit
positive acknowledgement and usable message ID establish acceptance, never
confirmed handset delivery or phone ownership.

The no-send account probe reports credit availability as unknown. No live key was
available here; actual account authentication, credit and phone receipt remain
deployment checks. Gmail still uses TLS SMTP and requires its own actual delivery
test. The logged `PESAPAL_IPN_NOT_CONFIGURED` is a separate configuration blocker:
register the reachable HTTPS callback and save that environment's notification ID
before checkout can submit a payment.

Environment templates are grouped by purpose, contain no populated credentials,
and remove obsolete SMS and development-only reviewer settings. Development Redis
is opt-in. Production keeps verification, MFA, scanning, private media, shared
storage and launch requirements. Deployment promotion now requires an exact
successful CI push commit from `master` and verifies the same SHA in each target.

The cleanup deletes nine proven-unused PNGs in both public and preview assets
(18 files, 213,874 bytes). No static or dynamically constructed references used
them. Used artwork and the frozen base preview remain. Private privacy exports
are excluded from Git and Docker build context. Production archives exclude
development seeds, test suites, preview engines, local files and secrets, and
now include [LAUNCH.md](../production/LAUNCH.md), configuration, SMS and Pesapal
instructions.

## Current verification

- Targeted authentication, Super Admin, Redis, HTTP errors, packaging and fidelity:
  91 passed, zero failures or skips.
- Yoola, phone metadata, signup policy, fixture-secret safety and real OTP storage:
  33 passed, zero failures or skips. Provider requests use protocol fixtures.
- Real Chromium shared-flash journeys: 10 passed across desktop and mobile,
  including actual cart persistence, an intercepted failed response, literal
  HTML text, keyboard dismissal, 320px overflow and measured button alignment.
- Approved image and hero-motion journeys: 20 passed across desktop and mobile.
- Import/syntax/project checks, security scan (671 files), frontend and functional
  audits (40 EJS views), and dependency audit passed; zero known vulnerabilities
  were reported by `npm audit --audit-level=high`.
- Complete canonical regression on application checkpoint `048dc58`: 1,411 tests,
  1,396 passed, zero failures or cancellations, and 15 cases requiring explicit
  live HTTP base URLs skipped in that invocation. Runtime was 1,326,395 ms.
  All 15 were subsequently matched by name to fresh passing HTTP/browser cases;
  each selected server-context suite reported zero failures and zero skips.
- Public layout: 72 route/viewport cases, 42 measured controls, zero browser,
  clipping, alignment or overflow issues. Live public SEO checks passed published
  product links, canonical/schema output, no-JavaScript readability, missing-page
  404/noindex, published-only sitemap and private noindex behavior.
- The MongoDB integration audit passed all 12 stages with 11 balanced ledger
  transactions. The native concurrency audit passed the 20-way payment, refund,
  payout, shipment, procurement, return and Warehouse races.
- Current public accessibility scan: 42 cases, 15 passed, 26 failed and one
  project-specific skip. Every remaining violation ID is `color-contrast`; there
  were no rate-limit or other violation types. These are real failing launch
  checks, not accepted passes. The requested palette remains unchanged.
- The complete saved installer ran successfully with the frozen lockfile and
  confirmed the owned MongoDB/Redis fixtures ready. This establishes local setup;
  saving its cloud draft does not publish or restore a future environment.
- All three actual archive builders completed with their secret/path guards:
  production (748 files), clean application (754 files) and engineering source
  (1,111 files), each with a SHA-256 sidecar. This is packaging verification, not
  a production deployment or a release approval. Runtime archives carry the
  launch, configuration, SMS and Pesapal instructions.

The previous [complete recovery verification](2026-10-25-verification.md) remains
historical evidence for its application checkpoint. Its external provider and
approved-colour contrast limits still apply. Production promotion must wait for
current CI, accessible approved controls and genuine deployment/evidence checks.
