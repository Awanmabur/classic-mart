# Cleanup and approved UI restoration — 14 October 2026

This record covers the current cleanup and hardening checkpoint on
`approved-dashboard-ui`. It supersedes older Customer-only and uniform-photo
repair descriptions. It does **not** certify a completed production launch.

The later [runtime hardening follow-up](2026-10-15-runtime-followup.md) records
the approved seller-enrolment contrast fix and subsequent runtime changes.
The test counts and archive hashes below belong to this earlier checkpoint.

## Implementation

- Removed 27 confirmed obsolete files, totaling 470,090 bytes, and the empty
  vendor directory. Superseded dashboard code, unused asset engines and stale
  generated manifests are gone. Referenced domain code and frozen design
  references remain; production packaging excludes prototype engines and previews.
- Restored the original marketing stylesheet before the broad photo override.
  Categories remain circular and photos retain their component-specific geometry.
  Only the small homepage promo banners use larger 32px frames and 24px photos.
  Dashboard controls keep approved padding, type, colors and corners, with narrow
  adapters for real forms and mobile placement. The five frozen approved base
  files were not edited.
- Generated all favicons and PWA artwork from the genuine homepage cart/red-bag
  logo. Every runtime HTML document includes the shared icon head. Fingerprints,
  icon revalidation and service-worker cache v32 prevent stale branding/styles.
- Replaced per-process production rate limits with atomic, shared, fail-closed
  Redis counters; moved the global limiter before body/session/page work.
  Public assets receive content fingerprints. Session/CSRF-bearing pages and
  errors remain private and no-store; country variants vary on Cookie/CF-IPCountry.
- Removed noisy successful access and idle worker logs, removed unused pino-http,
  sanitized errors/route templates and kept meaningful warnings, failures and
  security audit records. Fatal shutdowns retain a failing exit status.
- Restricted production public registration to released Customer/Seller/Promoter
  flows. Production market selection cannot manufacture an inactive/unlaunched
  Uganda fallback. Bootstrap cannot promote an ordinary account or reactivate an
  inactive administrator. Production rejects placeholder/local canonical domains.
- Added password/MFA-protected staff and launch-evidence operator commands with
  current grant/account checks, explicit versions, single-use MFA, atomic audit
  and rollback. No real invitations, grants or evidence were applied.
- Production readiness requires a recent successful completed worker cycle from
  the same full build SHA. Docker's empty SHA default preserves Render's runtime
  commit fallback. Root-owned application files are readable but not writable by
  the non-root runtime user; mounted operational storage stays writable.
- Added configured-domain metadata, factual structured data, crawlable catalogue
  content and no-script product details, bounded market-aware sitemaps, robots and
  `llms.txt`. Missing/unpublished public records return 404. A scheduled country
  CMS override retains the valid published global fallback until activation.

## Actual verification

Node **24.19.0**, npm **11.9.0**, system Chromium, isolated transaction-capable
loopback MongoDB and a dedicated loopback Redis fixture were used. Tests ran
serially with normal authentication limits and IDS/IPS retained. Local delivery
sinks and disposable data do not establish real provider delivery or settlement.

| Check | Actual result |
| --- | --- |
| Broad canonical Node suite | 1,114 entries: 1,099 passed, 7 failed, 8 skipped; 26m36s; exit 1 |
| Focused release/security/cache/packaging regressions | 104 passed; 0 failed/skipped |
| Operator authentication, transactional staff/evidence and worker checks | 24 passed; 0 failed/skipped; includes an actual spawned worker cycle and shutdown |
| Eight-role dashboard browser sweep | 9 entries passed; 131 route/workspace pairs at 1366/390/320px, 393 visits, 1,326 controls and 24 photo observations |
| Desktop/mobile hero and photo cases | All 20 distinct cases passed across final runs; see correction below |
| HTTP identity/customer/phone/order/retired-route cases | All 11 distinct cases passed across final runs; no skips |
| Actual public SEO requests against seeded MongoDB | Published HTML links, canonical/schema/no-script content, missing-product 404, product sitemap, robots, llms and private-page noindex assertions passed |
| Public layout sweep | 24 routes at three widths: 72 visits, 42 selected text controls; no JavaScript errors, clipped labels or document overflow |
| Stage 1–12 database integration audit | Passed; actual fixture checkout/shipment/refund and 9 balanced ledger transactions |
| Native concurrency audit | Passed under 20-way races for payment, refund, payout, shipment, procurement, return and warehouse claims |
| Source/import, static security, frontend/functionality checks | Passed: 611 JavaScript files, 580 security-scanned files and 40 EJS views |
| Dependency audit | `npm audit --audit-level=high`: zero vulnerabilities |
| Reusable environment installation | Complete composed install script executed successfully; frozen-lock install and source checks passed |
| Restarted Redis fixture and post-install native checks | Owned Redis stopped/restarted through the saved helper; 15 branding, cryptography and real shared-counter entries passed without failures/skips |
| Runtime ZIP installation and smoke | Production and clean packages each installed with `npm ci --omit=dev`; real imports, HTML/icons, absent prototypes and failed readiness without MongoDB all verified |
| Non-root container source/storage permission probe | Passed using the actual COPY and permission commands; separate component image only |
| Full production image | Blocked at official ClamAV definition download; no completed production image or vulnerability-scan claim |

The broad run's seven failed entries include three stale static expectations,
the notification layout assertion and its parent, and the existing Seller
enrolment colour-contrast assertion and its parent. The three static checks were
corrected for current mounted route maps, request/device-aware media access and
the canonical Admin boundary; the 104-entry rerun passed. The notification action
now preserves desktop geometry and remains usable below its text on mobile; the
complete nine-entry dashboard sweep passed afterward.

The initial 20-case hero/photo run passed 19 and failed one test that expected
23px on the mobile cart recommendation frame. The unchanged approved stylesheet
uses 18px there. The expectation was corrected to the original responsive value;
the full mobile cart/checkout case then passed. No card CSS was changed to satisfy
that expectation. An old guest `/returns` expectation was also corrected to the
intentional 301 `/return-policy` canonical redirect; the complete Customer
persistence/isolation case then passed.

The broad run's eight skipped external-server cases were subsequently activated
through owned HTTP fixtures, covering actual signup/login, email/onboarding,
optional phone verification, customer persistence, Chromium navigation, country
selectors with and without JavaScript, order filters and retired assets. The
11-entry HTTP group contains those eight cases plus its three existing contracts.

The remaining broad-suite failure is **`color-contrast` in the approved Seller
enrolment palette at 390px and 1366px**: `.role-heading > span`, `b`,
`.details-heading > span` and a button. The approved colours remain unchanged and
the assertion remains enabled. The full release/WCAG gate is therefore not green;
focused passing checks must not be relabeled as a passing full suite.

## Runtime artifacts

Both runtime archives passed ZIP CRC, exact file-set checks, every manifest
SHA-256/byte count and local-state/secret/prototype exclusions. Neither includes
node_modules or runtime environment files. Dependencies were installed afterward
in their staging directories for the real package smoke checks, not in the ZIPs.

| Archive | Manifest files | ZIP bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `classic-mart-v2.13.74-production.zip` | 661 | 2,727,326 | `dc01321c40deddbb7f4e685003c3ef204c7dfca66862ae94e09f8882678389b6` |
| `classic-mart-v2.13.74-clean.zip` | 667 | 2,734,218 | `eb2860bbe3a513b0e151f68f1bcbf31aaab0b5402d29975cb16e35afa5bc262b` |

The engineering/source archive is built separately and retains the approved
references and tests required to review the source.

## Local response measurements

Twenty warm HTML requests per route, measured through an owned loopback proxy
against the seeded fixture:

| Route | First request | Warm p50 | Warm p95 | HTML bytes |
| --- | ---: | ---: | ---: | ---: |
| `/` | 252.8ms | 26.5ms | 49.5ms | 89,586 |
| `/products` | 16.5ms | 11.3ms | 13.9ms | 39,240 |
| `/categories` | 11.5ms | 9.7ms | 15.7ms | 35,298 |

These are local response measurements, not WAN latency, production capacity,
Core Web Vitals or a performance-score guarantee. Raw observations are in ignored
`artifacts/production/local-http-1792008339279.json`.

## External blockers and scope limits

- This cloud runtime has no configured actual `BASE_URL`, launch markets, real
  production MongoDB/Redis/R2, Gmail, eSMS Africa or Pesapal credentials. Their
  real delivery, settlement and deployed readiness remain unverified here.
- Full Docker build exited 1 because `freshclam` could not fetch signed official
  definitions. A standard HEAD request to
  `https://database.clamav.net/daily.cvd` confirmed proxy tunnel **403 Forbidden**.
  Keep definition/signature/TLS verification enabled. An added draft domain does
  not apply access or validate a new build until settings are saved and retried.
- Official Google Trends access was also proxy-blocked. Public Google/Bing
  suggestion observations are documented in `../seo/keyword-research.md`.
  Suggestions do not establish frequency, search volume or trending demand.
- All 19 real launch-evidence gates and unresolved high/critical findings remain
  authoritative. Independent review, live provider certification, infrastructure,
  disaster recovery and controlled-pilot sign-offs were not fabricated.
- No production deployment/migration, complete image scan, ranking guarantee,
  absolute security claim or fresh-task environment restoration was performed.

Use [staged launch operations](staged-launch.md) for the actual operating workflow.
