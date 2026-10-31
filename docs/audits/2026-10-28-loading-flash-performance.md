# Loading feedback, notifications and request performance

This change preserves the approved layout and palette. It removes repeated work
and gives members feedback while real requests are pending; a spinner does not
make a request complete sooner.

## Changes

- Information-page headers request category names and links instead of the full
  product catalogue. Product/cart pages still share their existing catalogue
  promise. Restricted category visibility retains current market, publication,
  store, brand, independent approval and active-price checks. Proof stops at the
  first eligible product per restricted category. Signed-in responses remain
  private and include no account state or CSRF token.
- Concurrent cold asset requests from the same IP share one security lookup.
  Existing positive/negative cache lifetimes stay bounded at 15 seconds, and
  positive entries cannot outlive the actual block. Applying/revoking a block
  invalidates pending reads, including failed old reads. Static files still pass
  through the security shield.
- Public assets with a matching content fingerprint and an origin-supplied
  `immutable` response can use the service-worker cache without a repeat network
  request. Private routes stay uncached. Catalogue photographs recheck their
  current publication policy and cannot fall back to withdrawn cached bytes.
  Cache namespace v36 retires the previous cached media.
- Transient server/client notices have a close button and five seconds of reading
  time. Hover or keyboard focus pauses the remaining time until the member leaves
  the notice. Dashboard notices have smaller padding and constrained widths.
  Essential ongoing verification/eligibility notices and field validation remain
  available. Contact and coupon action messages use the same notification system.
- Delayed, non-blocking loading feedback follows document navigation, native form
  submissions and same-origin fetch work. Fast requests do not flash a loader.
  Cancellation, failed requests and restored pages clear pending state; native
  submissions preserve the submitter's name/value and CSRF fields. Reduced-motion
  users receive a static indicator. No artificial percentage or delay is added.
  Native and custom modal dialogs keep the status accessible. Known CSV/PDF
  attachment routes use the browser's download feedback, avoiding a page loader
  that cannot observe download completion. Manually streamed operations can use
  `ClassicMartLoading.track()` around their complete operation.
- The launch load-smoke command now measures the complete response body and
  counts interrupted downloads once, rather than treating headers as completion.
- The `qs` override moves from 6.16.0 to the compatible security patch 6.16.1;
  no other dependency version changes. A frozen reinstall and fresh full
  dependency audit report zero findings. The committed SBOM is regenerated from
  the updated lockfile. This is a point-in-time dependency result, not a claim
  that the whole platform is free of security risks.

## Controlled comparison

The baseline is master `aa9295f`. Both versions use a fresh process, the same
40-product disposable fixture shape, a real MongoDB replica set and a loopback
TCP proxy adding 12 ms in each direction. The asset burst makes 48 concurrent
requests. These are diagnostic visits, not production capacity measurements or
Core Web Vitals. Both versions also enforce a newly applied IP block and allow
requests after its explicit revocation/invalidation.

| Work | Before | After |
| --- | ---: | ---: |
| Header category-data database reads | 13 | 2 |
| Header category-data response bytes | 57,292 | 102 |
| Header category-data elapsed time | 158.6 ms | 51.3 ms |
| Cold asset-burst security lookups | 29 | 1 |
| Cold asset-burst total elapsed time | 151.3 ms | 121.8 ms |

The new header response intentionally omits product cards: those remain fetched
only by pages that use them. A separate restricted-category fixture verifies the
three-read proof path, withdrawal rules and early termination. Raw local reports
are `/tmp/classicmart-launch-speed-before.json` and
`/tmp/classicmart-launch-speed-after.json`; they contain only owned fixture data.

## Verification and deployment

Meaningful coverage includes the real database navigation/publication/privacy
tests, security-cache concurrency/invalidation tests, delayed/interrupted load
smoke response, desktop/mobile flash timing and dismissal, and real Chromium
loading behavior. The final combined run passed 44 results with no failures or
skips; the separate desktop/mobile flash run passed all 18 cases. SMS/security
management passed 22 results, and the corrected passkey run passed all eight.
Release/import/syntax, static security, frontend and functionality checks pass.
Existing catalogue and request-path security regressions remain part of
verification. A controlled delayed passkey request exposed an existing
test waiting for a visible intermediate status instead of the actual cancellation
result. Its wait now targets the same cancellation text, with all cryptographic
and authorization assertions retained; the real passkey regression passes.
Provider acceptance is separate from handset receipt;
the user reports delivery on another MTN and an Airtel line, with the original
MTN line's issue still specific to that recipient.

Use [the launch handoff](../production/LAUNCH.md) for deployment. Run the app and
worker with `NODE_ENV=production`; development intentionally disables production
view/asset caching. Keep web, Redis and MongoDB geographically close. Remote
database round trips, an undersized/free sleeping host, dependency outages and
carrier delivery cannot be eliminated by frontend loading feedback.

After deployment, run the existing deployment smoke and launch checks against
the actual HTTPS origin/build. Local tests do not establish live hosting
capacity, payment reconciliation, scanner freshness, backup recovery or the
required independent launch evidence. No deployment or launch gate is bypassed.
