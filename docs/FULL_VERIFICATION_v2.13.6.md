# Classic Mart v2.13.6 Verification Record

## Scope

This release verifies the official logo rollout, fixed storefront top, pre-hero banner removal, one-price quantity behavior, shared current-page EJS product preview, voice search, image search, and newsletter subscription workflow.

## Completed checks

- Every JavaScript file under `src`, `public`, `scripts`, and `test` passed `node --check`.
- `scripts/security-check.js` passed its static security gate.
- `scripts/check-imports.js` passed import/export integrity.
- `scripts/audit-frontend.js` passed all 54 EJS views.
- `scripts/audit-functionality.js` passed all 54 views and the preview/cart/catalogue/wishlist contracts.
- `scripts/check-release-scripts.js` passed for v2.13.6.
- 63 cumulative static regression tests passed, followed by 4 dedicated v2.13.6 storefront tests.
- The EJS delimiter sweep found no unbalanced `<%` / `%>` blocks.
- Requested invariants confirm that `cmsBanner`, `previewLineTotal`, `previewUnitPriceNote`, and `.preview-line-total` are absent from the active storefront preview implementation.
- The supplied official logo is bundled as a transparent RGBA PNG.
- A CycloneDX 1.6 SBOM is included at `docs/SBOM_v2.13.6.cdx.json`.

## Runtime verification command

Use Node.js 24.x, then run:

```bash
npm ci
npm run verify:local
npm run dev
```

The build sandbox used for this update had Node.js 22 and an internal npm mirror that did not contain the locked `zod@4.4.3` archive, so dependency installation, MongoDB integration tests, and `npm audit` could not be rerun inside that sandbox. The lockfile was preserved, and the project release gate remains configured to run those checks under the required Node.js 24 environment.
