# Recovery verification, 25 October 2026

The recovered application is verified on `recovery/end-to-end-20261023`.
It remains an unreleased recovery based on v2.13.74. Production launch is
blocked by the approved palette's accessibility contrast failures and the
environment-specific production verification described below.

The complete canonical run on application checkpoint
`f2cb355f91544ac6e0157d43097ebfc3e171a177` executed **1,386 checks:
1,371 passed, zero failed/cancelled and 15 required a separate live-server
fixture**. Every one of those 15 cases subsequently passed in its configured
HTTP/browser suite. Their names were matched against the canonical skip list;
none was treated as an unexplained or ignored skip.

After that complete run, changes only strengthened browser-test infrastructure
and its HTTP status assertion; production application behavior was unchanged.
The four new network cases passed alongside the 31 existing fixture-safety,
browser-contract and mail-version checks. The resulting **35-check targeted
run passed with zero failures or skips**. Counts include parent tests where
Node reports them; they are not counts of distinct product features.

| Current executable evidence | Outcome |
| --- | --- |
| Complete canonical regression | 1,371 passed, zero failures, 15 separately configured cases; `/tmp/classicmart-final-full-1371-pass-15-context-skips.log` |
| All canonical cases requiring external base URLs | All 15 matched cases passed; `/tmp/classicmart-external-context-15-pass.json` records their actual passing suite |
| Customer source links, five 67-record aftersales histories, addresses, exact wishlist movement, complete wallet CSV and private avatar recovery | All 8 passed in `/tmp/classicmart-production-customer-recovery-live.log` |
| Live identity, Customer state, Chromium signup/account actions, country-code controls, order filters and retired assets | All 11 passed across the six `production-web-checks.mjs http` suites; Customer Chromium also passed the final recovery invocation |
| Separate Seller/Moderator MFA sessions, cross-role denial, catalogue/search/cart and mobile Seller cards | 16 passed, four intentional project-specific skips; `/tmp/classicmart-isolated-ci-browser-16-pass-4-project-skips.log` |
| Approved image shapes, cart/checkout photography, hero controls and promotional motion | All 20 desktop/mobile cases passed in one isolated run; `/tmp/classicmart-final-image-motion-20-pass.log` |
| Public layout | All 72 route/viewport cases passed, 42 measured controls, no page errors, overflow or clipped/unbalanced controls; `/tmp/classicmart-final-public-layout-72-pass.log` |
| Browser fixture safety, real network isolation and release/mail contracts | All 35 passed; `/tmp/classicmart-browser-network-safety-contracts-35-pass.log` |
| MongoDB integration | All 12 stages passed and all 11 resulting ledger transactions balanced; `/tmp/classicmart-patched-integration-12-stages-pass.log` |
| Native MongoDB concurrency | Twenty-way payment, refund, payout, shipment, procurement, return and Warehouse races passed; `/tmp/classicmart-patched-concurrency-20-way-pass.log` |
| Public SEO and crawl controls | Live published-product links, canonical/schema output, readable no-JavaScript content, missing-product 404, published-only sitemap, robots/llms guidance and private noindex passed |

The full run also exercised the actual connected Customer, Seller, Promoter,
Finance, Support, Moderation, Country Admin and Warehouse layouts at 1366,
390 and 320 pixels. Business, Delivery and Super Admin have their separate
authenticated recovery suites. No preview dashboard was used as proof of a
working production flow.

The recovered fixes include:

- Scheduled CMS publication and rollback reload the exact current approving
  grant/token and revision digest, preserve independent authorship, support
  global Super Admin authority and advance a durable scan past blocked work.
- Business nonowner approvals require the explicit current `canApprove`
  permission in both controls and transactional service authorization.
- Seller finance, customer relationships and review disputes use canonical
  account, Device, accepted membership, owner, store and market checks.
  Invalid support forms preserve their authenticated context and return real
  422/409 responses with retained input in the correct Seller shell.
- Seller navigation rejects unavailable or managed owners. MFA continuation
  retains the owned invitation inbox. Suspended stores retain private case
  access while fulfilment stays locked.
- Finance retains verified historical source links and original currencies;
  provider-event searches resolve source IDs before filtering. COD requires
  independent Warehouse cash review. Historical reads do not relax current
  payout mutation policy.
- Customer history sources resolve owned order/payment/refund/return/reward
  lineage in bounded batches. Old focused records remain reachable; forged
  IDs, expired reward actions and wrong-currency checkout actions are excluded.
- Optional notification preferences affect queueing and dispatch. Offers require
  marketing consent; offer emails also require a currently verified address.
  Product-alert claims and push
  queueing are atomic. Obsolete progress emails and unknown legacy work
  cancel; security, access, receipts and requested service notices remain.
- CI creates separate Seller/managed Moderator accounts with real MFA.
  Test seeding refuses production/remote/unapproved databases and unsafe
  credential output. It masks individual recovery codes as well as complete
  lists. Browser tests use distinct real loopback TCP peers; HTTP data and
  cookies remain intact and application rate limits remain enabled.
- Hero dots have actual nonoverlapping 24px targets while retaining their
  visible 8px dots, 20px active pill, colours and vertical placement.

Local response-time measurements used 20 warm samples per route after one
initial request, through an owned loopback fixture:

| Route | First request | Warm p50 | Warm p95 |
| --- | ---: | ---: | ---: |
| Home | 274.5 ms | 16.0 ms | 29.5 ms |
| Products | 9.3 ms | 8.0 ms | 10.9 ms |
| Categories | 8.9 ms | 7.2 ms | 9.7 ms |

These are local HTTP measurements, not production capacity, global latency,
search ranking or Core Web Vitals. Raw results are in
`artifacts/production/local-http-1792913441717.json`.

The dependency audit initially found seven advisories, including five high
severity findings. Official patched releases were available despite the first
audit not offering an automatic fix for exact pins. Express 5.3.0, Multer
2.5.0, Nodemailer 10.2.1 and Zod 4.6.7 are now pinned; the lockfile resolves
body-parser 2.4.0 and ip-address 10.7.4. The final dependency audit reports
**zero vulnerabilities**. Integrity and TLS verification stayed enabled.

The complete reusable installer passed frozen dependency installation,
700 import/export checks, 732 syntax checks, the project gate and guarded
MongoDB/Redis readiness. The security static gate scanned 669 files; both
40-view frontend/functionality audits passed.
Log: `/tmp/classicmart-production-install-verified-final.log`.

The final public accessibility run executed all 42 desktop/mobile cases:
**15 passed, 26 failed and one mobile-only touch-target check was skipped in
the desktop project**.
Every remaining violation ID was `color-contrast`; there were no request-limit
failures. The approved orange/white, red/teal and pale-label combinations
remain unchanged pending the user's colour preference. The slider target-size
finding is fixed. The gate remains enabled and is a release blocker.
Log: `/tmp/classicmart-final-a11y-contrast-26-fail-15-pass-1-skip.log`.

Actual Gmail/eSMS Africa delivery and Pesapal reconciliation still require
the intended environment credentials and provider verification. Local fixtures
and development log transports do not prove external delivery or payment.
Production deployment, storage/scanner, backup and launch evidence remain
environment-specific release requirements. No 100% security/SEO or production
readiness claim follows from these local results.

Earlier failed runs are retained for transparency: the first complete run had
1,248 passes, 94 failures and 13 context skips; the second had 1,352 passes,
two obsolete static-contract failures and 15 context skips. Those contracts
and the actual product defects were corrected before the passing run above.
Logs: `/tmp/classicmart-first-full-1248-pass-94-fail-13-skip.log` and
`/tmp/classicmart-second-full-1352-pass-2-static-fail-15-skip.log`.
