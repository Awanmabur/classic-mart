# Customer routing, performance and security checkpoint

Verified on 7 October 2026 with Node 24, Chromium and a local MongoDB 8 replica set.

## Routes and request boundaries

The canonical customer routes are `/dashboard`, `/orders`, `/wishlist`,
`/addresses`, `/rewards`, `/wallet`, `/returns`, `/support`, `/profile`,
`/categories`, `/cart`, `/notifications` and `/club`. The shared customer route
registry supplies server routes, login destinations and browser navigation.
Old `/dashboard/:customerPage` GET links redirect with HTTP 308 and retain their
query strings. Existing address, wallet and notification submission URLs remain
protected aliases; new forms use the short URLs. Operational role pages retain
their existing assigned-role routes and production connection gates.

Guest categories/cart/return-policy browsing remains available. Signed-in users
see the approved customer categories/cart/returns pages at the same short URLs.
`/return-policy` is available to everyone. Authentication, verification,
onboarding, CSRF, account permissions and ownership checks remain enforced.

Authenticated responses and HTML carrying CSRF tokens or flash messages use
private/no-store caching. The service worker bypasses the new private routes,
and its cache namespace advances to evict old assets. Customer pages send
noindex/nofollow/noarchive headers. Public robots rules apply to ordinary and AI
crawlers; sitemap documents contain public pages and published products for the
site's default Uganda catalogue, with at most 1,000 products per XML document.
Other country-specific catalogue discovery requires a regional URL strategy.

## Performance changes

Customer reads share executed promises only within one request. Null results
are shared too. No account, authorization, balance or device-revocation result
is cached across requests. Header and page data load concurrently; wallet
history loads only on the wallet page. Overview spend/savings use one aggregation.
Currency/date formatters are reused within a rendered request.

Ledger balances filter transactions by account before expanding entries and use
an account-entry index; the second filter after expansion preserves correct
multi-account totals. Additional compound indexes support customer order,
notification, cart, refund, loyalty, support, dispute and trust-case queries.
Production disables automatic index creation: deploy the declared indexes using
the existing database migration procedure before assessing production speed.

Approved CSS/JS URLs carry content hashes computed at startup. Matching assets
can be cached immutably in production; changed content gets a new URL. Customer
scripts use defer. The three original Final19 base stylesheets remain unchanged.

Warm local HTTP measurements used a fresh customer account, one warm-up and
seven sequential samples per page, with MongoDB command monitoring. Timings
include HTML rendering/session operations and are not production benchmarks.

| Page | Commands before | Commands after | Median before (ms) | Median after (ms) |
| --- | ---: | ---: | ---: | ---: |
| Dashboard | 18 | 14 | 56.49 | 35.34 |
| Orders | 10 | 9 | 43.64 | 35.19 |
| Addresses | 10 | 9 | 27.38 | 29.45 |
| Rewards | 11 | 9 | 124.39 | 32.99 |
| Wallet | 9 | 9 | 18.88 | 31.07 |
| Categories | 9 | 8 | 22.63 | 29.52 |
| Cart | 11 | 10 | 23.27 | 30.62 |

Some small local timings increased; these samples do not establish a universal
speed improvement. Query reductions and indexed ledger access are the durable
changes. Production latency depends on database/network distance, data volume,
instance resources and concurrent traffic.

## Security dependencies and verification

Pinned patched releases: compression 1.8.2, express-rate-limit 8.7.1, Multer
2.4.0, Nodemailer 10.0.16 and Sharp 0.35.5. The lockfile also updates proxy-addr
2.0.8 and ip-address 10.7.3. The dependency audit reports zero known vulnerabilities
at this checkpoint; that is not a guarantee against unknown vulnerabilities.

Refund data is loaded through orders belonging to the customer. Refund has no
userId field, so filtering it directly by userId was unsafe under strictQuery.
A two-account MongoDB regression test verifies refund isolation. Ledger tests
verify debit/credit totals across accounts and account-index document examination.

All 369 tests pass without skips, including live signup, verification, returning
login, account isolation, address editing, cart persistence, order status tabs,
CSRF rejection and Gmail TLS downgrade protection. Project/import, security,
frontend and functionality gates pass. All 13 customer pages and Password &
Security pass desktop/mobile Chromium checks. The 20-way concurrency audit passes. The Stage 1–12 MongoDB backend
integration audit also passes, including delivery proof, COD handover,
warehouse return inspection, refunds, exchanges and business invoicing. The
ledger account schema now accepts the business owner type used by invoicing.
The audit supplies its own isolated administrator and follows current
paginated-directory, order-line and persisted-approval contracts.

The final public load smoke test completed 100 requests at concurrency 10 with
zero errors, p50 52 ms, p95 114 ms and p99 204 ms.
Live Gmail/eSMS delivery and Pesapal settlement still require configured provider
credentials and external validation. Unconnected operational dashboards remain
blocked in production; this checkpoint does not complete their backend wiring.

To update a local checkout, stop its server, pull approved-dashboard-ui, run
`npm ci` to install the patched lockfile, then restart `npm start`.
