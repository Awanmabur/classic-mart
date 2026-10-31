# Hero, image corners and request performance — 25 October 2026

This continues the launch candidate on `master` from `d9866f156fb8849640a017e665a0e4055f4a2dad`.
It does not certify production provider delivery or production capacity.

## Homepage source and controls

The previous no-CMS path rendered one fixed fallback banner. Development fixtures
created three published CMS records, which masked that difference. The homepage
now gives active published `home.hero.*` revisions priority and otherwise selects
up to six distinct, in-stock products from the current public catalogue. It does
not create marketing records. Zero and one-product cases do not invent slides.
Native product/category links work before JavaScript. With two or more slides,
the existing manual, swipe and 5.6-second automatic controls apply, including
hover, focus, hidden-page and reduced-motion pauses.
Catalogue copy clamps to three lines without changing CMS styling. Real maximum
length product names, including unbroken identifiers, retain visible native
product links at 320, 390, 1024 and 1366 pixels.

See [Homepage content](../production/HOMEPAGE_CONTENT.md) for the real publication
workflow, market precedence, inventory conditions and troubleshooting attribute.
Inline catalogue JSON uses the shared HTML-safe serializer, including the
homepage, so product text cannot close its script element.

## Image geometry

Only the small homepage promotional banners gain larger frames: 36px frames,
32px photos. Inset live dashboard product photos use 23px corners matching the
homepage product photos. Wide/portrait `object-fit: contain` photos clip their
visible photo rectangle with calculated insets; their original dimensions,
aspect ratio and image content remain intact. This also rounds the actual small
promotional photograph inside its letterbox. Each relevant page controller uses
one ResizeObserver and image load/error handlers to update clipping, without
global mutation polling. Circular categories, identity avatars,
icons, logos, button styling and frozen approved dashboard styles remain intact.
The readable product detail also has rounded photos with JavaScript disabled.

## Architecture and changes

The application remains a modular Node.js/Express monolith with EJS rendering,
MongoDB, optional Redis sessions and independent worker execution. That structure
can support the current marketplace. The immediate bottleneck was repeated work
and sequential remote database reads; these changes do not introduce a new
service boundary or cross-request authorization cache.

- Public catalogue photos run after the existing security shield and global
  request limiter, before unrelated account/session/navigation work. Two indexed
  aggregate commands check current media, product, store, category, brand,
  independent restricted-product approval and active country/currency sources:
  once before storage access and again before sending bytes. Private photos use
  the existing session, device, membership and MFA path. The legacy fallback
  enforces the same market eligibility, including withdrawals during object reads.
- Business navigation stops after an empty accepted-membership result. Independent
  business and seller navigation reads overlap after current identity validation.
  Feature flags load only for their actual storefront and Ask Classic consumers;
  disabled AI rollouts and feature-store failures still fail closed.
- Seller workspace and operational reads avoid duplicate same-owner identities,
  repeated membership reads and impossible empty subscription-charge queries.
  Independent nontransaction reads and page/header preparation overlap. Current
  final authorization checks remain in place; transaction reads stay ordered and
  identity, device, membership, store and market write fences remain unchanged.
- Valid server-rendered catalogues, including empty markets, are reused by page,
  common-header, cart and preview controllers. Guests omit unused personal-state
  requests. Signed-in pages request a bounded, private saved-ID summary rather
  than hydrating all product lists and recommendations again. Opening a preview
  requires successful fresh product details before purchase controls appear.
- Catalogue database reads project only required fields and overlap independent
  metadata/media/metrics reads. Sales metrics narrow relevant product IDs before
  unwinding order lines. A compound `country/status/items.productId` order index
  supports that predicate. Apply model indexes through the existing reviewed
  migration/bootstrap deployment steps; production disables automatic indexing.

## Controlled before/after measurements

The comparison uses a frozen archive of the preceding commit and the changed
source, the same disposable seeded database shape, real password/device login,
development Mongo-backed sessions and a loopback TCP proxy adding 12ms in each
direction (approximately 24ms MongoDB round-trip time). Each route has one cold
request followed by five warm requests; the table reports the warm median.
The photo fixture contains real stored WebP bytes. This is a diagnostic fixture,
not the user's connection, a throughput test or production Core Web Vitals.

| Role and route | Before, ms | After, ms | Database commands before → after |
| --- | ---: | ---: | ---: |
| Guest home | 46.3 | 43.9 | 6 → 6 |
| Guest products document | 8.3 | 10.5 | 0 → 0 |
| Guest categories document | 7.4 | 7.8 | 0 → 0 |
| Customer dashboard | 279.8 | 227.8 | 18 → 16 |
| Customer orders | 171.4 | 120.8 | 14 → 12 |
| Customer security | 198.3 | 144.5 | 17 → 15 |
| Seller overview | 1064.2 | 524.1 | 54 → 42 |
| Seller orders | 583.0 | 351.4 | 31 → 25 |
| Guest catalogue photo | 262.6 | 56.2 | 10 → 2 |
| Signed-in catalogue photo | 389.7 | 56.2 | 16 → 2 |

Seller overview latency falls 50.7%, seller orders 39.7%, and signed-in photo
latency 85.6% in this fixture. No claim is made that every route became faster.
The products/categories documents grow from 39,298/35,356 to 66,105/62,163
uncompressed bytes in the 12-product fixture because they now inline the public
snapshot. This replaces repeated full catalogue API downloads and preserves
existing local filter/sort/count behavior. The table measures documents alone;
browser network regression checks separately verify duplicate downloads are gone.
The homepage already inlined its snapshot. A full public snapshot remains bounded
at 300 products; category-scoped pages at 80.

A second comparison opens each guest page in a fresh Chromium context with
compression, images and fonts enabled. Actual isolated loopback TCP peers keep
the production rate limiter enabled. CDP received-byte counters include response
protocol overhead. These are single diagnostic visits, not latency percentiles.

| Guest route | Catalogue/state requests before → after | Compressed document + catalogue + state bytes before → after | All response bytes before → after |
| --- | ---: | ---: | ---: |
| Home | 1 / 0 → 0 / 0 | 23,133 → 16,787 | 667,559 → 660,965 |
| Products | 2 / 1 → 0 / 0 | 17,810 → 13,132 | 630,147 → 626,277 |
| Categories | 2 / 1 → 0 / 0 | 17,942 → 12,812 | 629,814 → 625,492 |

The document/catalogue/state transfer falls 27.4%, 26.3% and 28.6% respectively
in this fixture. Whole-page savings are smaller because unchanged photos,
scripts, styles and icons dominate initial transfers. Every observed request
returned 200, with no interrupted, incomplete or rate-limited requests. Signed-in
summary behavior is covered separately by actual browser and HTTP tests.

Raw local comparison reports: `/tmp/classicmart-performance-before.json` and
`/tmp/classicmart-performance-after.json`, plus
`/tmp/classicmart-browser-transfer-before.json` and
`/tmp/classicmart-browser-transfer-after.json`. These files contain fixture timings and
command counts, not production credentials or account data. Keep production app,
worker, MongoDB and object storage geographically close; database DNS or network
outages still require correcting the actual deployment connectivity.

## Verification

- Complete canonical run: 1,442 tests, 1,427 passed, zero failed and 15 cases
  requiring a separately running web server skipped. All 15 were matched by name
  to fresh passing actual HTTP/browser results, covering identity, account data,
  recovery, address concurrency, wishlist replay, wallet exports, avatar cleanup,
  phone controls, order filters and retired asset URLs.
- Final image/motion browser run: 28 passed across desktop and mobile, including
  visible wide/portrait promotional and dashboard photographs, unchanged image
  dimensions and circles, no-JavaScript product detail, and all marketing motion
  controls. Catalogue hydration/preview browser run: another 28 passed.
- The canonical dashboard sweep visits 142 connected pages across three widths,
  checking 1,407 controls and populated photos against the frozen approved styles.
- Fresh publication/authority tests verify two-command public photo reads,
  signed-in/anonymous byte equivalence, HEAD behavior, withdrawal of every source,
  withdrawal during object storage access, private preview MFA, revoked devices
  and membership, disabled AI flags, personal saved-state isolation, projected
  private fields, fresh price/stock and all transaction fences.
- Maximum-length actual product names/descriptions keep native hero links visible
  at four widths. Saved script-terminating product text remains valid inert JSON.
- Live public SEO smoke checks pass for server-rendered product links, canonical
  URLs/schema, no-JavaScript details, genuine missing-product 404s, published-only
  sitemaps and private-page noindex rules.
- The complete saved setup installer executes successfully with `npm ci`, 713
  import/export checks, 746 syntax checks and both owned database fixtures ready.
  Final security scanning passes for 675 files; frontend/functionality audits
  pass for the 40 public views and their catalogue/cart/preview behaviors.

Canonical log: `/tmp/classicmart-hero-performance-full-1427-pass-15-context-skips.log`.
External-case match report:
`/tmp/classicmart-hero-performance-external-context-15-pass.json`. Browser logs:
`/tmp/classicmart-production-visual.log` and
`/tmp/classicmart-production-catalogue.log`.

An initial obsolete source assertion expected full recommendations on every
saved-state read. It now requires the explicit authenticated, non-summary branch;
actual guest/default/summary HTTP behavior is covered independently. Browser
testing also caught the homepage's previous stale preview fallback on a withdrawn
listing; the corrected implementation passes both withdrawal and late-request
race checks. Those failed diagnostic runs are not counted as passing evidence.

The provider, production deployment/capacity and unresolved colour-contrast launch
gates in [the preceding launch audit](2026-10-25-launch-fixes.md) remain separate.
These changes preserve approved colours and do not claim production certification.
