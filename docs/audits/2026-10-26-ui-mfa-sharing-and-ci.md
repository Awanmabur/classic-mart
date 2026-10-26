# UI, authenticator setup and release verification — 26 October 2026

This change addresses the requested product-preview spacing, sharing, photograph
corners, centred cart notifications, MFA presentation and dashboard labels. The
approved page structure and the primary orange fill, `#ff6500`, remain in place.
The user subsequently approved **minimal contrast corrections**, superseding the
earlier exact-colour restriction described in
[the CI setup audit](2026-10-25-ci-browser-setup.md). Strict WCAG checks remain
mandatory; no accessibility rule or release gate is suppressed.

## Product previews and shared notifications

- Price-drop actions have 14px of separation above them. Related-product frames
  and the actual photographs have 14px corners. The homepage's small right-hand
  banners use 24px frame corners and 20px photograph corners, reducing the
  previous 36px/32px treatment.
- The seven existing banner transforms and their timing remain intact. Only
  decorative photographs fade; labels and their backgrounds stay opaque so
  animation cannot temporarily make their contrast unreadable.
- Both preview implementations use `public/product-sharing.js`. It invokes the
  native share sheet directly from the click when supported, using the current
  product's canonical URL and country. Cancelling the share sheet does not
  report success. Clipboard success is reported only after copying succeeds;
  unavailable or denied clipboard access leaves a selectable link and clear
  manual-copy instructions. Old asynchronous results must not affect a newly
  selected product.
- Preview and mobile-filter dialogs isolate background content with `inert`,
  preserve its original state and restore it before returning focus. The shared
  notification remains available to assistive technology.
- The existing singleton flash surface is centred in the viewport and moved
  under `body` to avoid transformed-ancestor clipping. It retains a full primary
  border, dismiss control, literal-text rendering and bounded mobile dimensions.
  Cart actions continue to use this same surface.

## MFA enrollment and sign-in

`/mfa` now uses the styled authentication shell, with clear instructions for an
authenticator code or an unused recovery code. A sign-in challenge never exposes
an enrollment key or QR image.

Account security provides three setup steps, a locally generated PNG QR image,
a collapsed manual-key fallback and instructions to save recovery codes offline.
The production dependency is pinned to `qrcode@1.5.4`; no external QR-generation
service receives the secret. The image is 256px square with a four-module white
quiet zone. Photograph rounding deliberately does not apply to the QR image.

`GET /account/mfa/qr-code.png` requires the current authenticated, verified
account and its genuine pending enrollment. It ignores a supplied target-user
identifier, limits reads per account, and checks current device/account authority
and the pending enrollment again after encoding. Confirmed or replaced factors,
revoked devices and changed account-token versions cannot receive the old image.
Responses are private and `no-store`, use same-origin resource policy and omit
ETag/Last-Modified validators. Enrollment confirmation and privileged MFA
requirements remain enforced; the QR route does not relax authorization.

## Dashboard presentation and cache freshness

Photographs in the connected dashboard cart, order, product and related photo
areas use 23px corners while preserving their dimensions and fit. Avatar and
category circles are unchanged. Targeted form/action spacing repairs preserve
the approved controls' geometry elsewhere.

Visible generated references use explicit presentation helpers. An authorized
account name is used where already available; otherwise a person reference reads
“Account holder.” Other known record types use a descriptive label and short
reference suffix. The helpers neither fetch additional private identities nor
rewrite route targets, form values, DTOs or exports. Ordinary free text and
embedded identifiers are not globally replaced.

The service-worker cache changes from v32 to v33 so existing clients receive the
updated assets. `/mfa` joins the private paths that bypass asset/navigation
caching. Readable action text uses the scoped companion colours `#111827` and
`#b94b00` where needed; the brand-orange fill and page geometry are retained.

## Verification record

Completed targeted checks reported by the root verification run:

- Shared flash: **10 passed**, no failures or skips, across desktop and mobile,
  including real cart success/failure, centring, transformed ancestors,
  deduplication, dismissal and focus safety.
- Dashboard sweep: **9 passed**, no failures or skips; **142 connected pages,
  1,407 controls**, across 1366px, 390px and 320px widths in all eight tested
  workspaces. It checks photograph corners, action spacing, overflow and the
  preserved control appearance.
- Seller MFA continuation: **6 passed**, no failures or skips after restoring
  the explicit instruction to save recovery codes offline. The flow includes
  desktop/mobile enrollment, recovery codes, continuation to the Seller store
  and revoked-membership denial.
- Targeted QR checks passed against a disposable database, including actual PNG
  encoding of the current enrollment URI, ownership/privacy, authority changes
  during encoding, desktop/mobile setup and sign-in with a single-use recovery
  code. This verifies the encoder input and real authentication flow; it is not
  an independent third-party QR-scanner certification.
- The dependency audit after adding the QR encoder reported **zero
  vulnerabilities**.
- The final combined desktop/mobile browser run passed **149 tests**, with no
  failures or retries. Its **13 declared skips** comprise five project-specific
  exclusions and eight cases needing the isolated simple-customer-login fixture.
  The strict WCAG suite, real Seller/Moderator MFA, shared flash, dialog isolation
  and native/copy/manual product-sharing cases all passed. The sharing tests
  include delayed clipboard callbacks after switching products.
- Separate customer-capable fixtures passed **30 image/marketing-motion cases**
  and **28 catalogue cases**, with no skips; these execute the eight cases above.
  A **72 page/width** public-layout sweep found no browser errors, clipped
  controls or horizontal overflow.
- Seven HTTP/browser account suites passed **19 tests**, with no skips, covering
  identity, customer persistence, recovery, the country selector, order filters
  and retired-dashboard cleanup. Public SEO checks passed for canonical links,
  structured data, published-only sitemap content and private-page noindex.
- The saved complete setup installer was rerun successfully against this source
  candidate, including `npm ci`, project checks and owned MongoDB/Redis readiness.
- The complete canonical regression passed **1,460 tests**, with **zero failures**
  and **15 declared HTTP-dependent skips**, in 1,402 seconds. Those fifteen cases
  all execute in the separate nineteen-test HTTP/browser run recorded above.
  This includes the real QR authority races, desktop/mobile enrollment and
  recovery sign-in, Seller signup and continuation, and all eight workspaces.
- Final security, frontend and functionality gates passed. The setup installer
  also ran the release-script, import/export, JavaScript syntax and project gates.

The hosted result for this commit is tracked by
[Classic Mart CI on master](https://github.com/Awanmabur/classic-mart/actions/workflows/ci.yml?query=branch%3Amaster).
Local results do not establish the hosted managed-browser, dependency, SBOM,
container vulnerability or release-attestation results. The earlier
hosted run [40241982569](https://github.com/Awanmabur/classic-mart/actions/runs/40241982569)
passed the browser/runtime setup and canonical tests but failed the accessibility
stage. Its later dependency, SBOM, container, vulnerability and attestation gates
did not run; their success must be established by the new hosted result.

Local browser checks use the installed system Chromium and disposable loopback
MongoDB/Redis fixtures. They do not establish hosted managed-Chromium results,
real Gmail/Yoola/Pesapal delivery, deployment readiness under production load or
an absolute security guarantee. Provider credentials and production launch
checks remain separate requirements.
