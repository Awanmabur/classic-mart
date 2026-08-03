# Classic Mart v2.13.5 verification record

v2.13.5 is the cumulative mobile variant-authority and Stage 11 integration repair built on v2.13.4.

## Correction scope

- Preserve aggregate `product.stock` for catalogue/product discovery.
- Preserve exact `variant.stock` for preview, cart and mobile commerce lines.
- Compare mobile cart price, availability and SKU with the selected published variant.
- Verify aggregate product stock separately as the sum of published variant stock.
- Reject future Stage 11 audits that compare variant cart availability with product aggregate stock.

## Release gates

The release requires:

1. release-script preflight;
2. import/export integrity;
3. project, route, EJS and asset checks;
4. Stage 12 security scan;
5. frontend database/functionality audit;
6. commerce functionality audit;
7. all automated tests;
8. MongoDB transaction verification;
9. Stage 1–12 real integration audit;
10. npm vulnerability audit.

## Environment boundary

The complete dependency-backed gate must be run on Node.js 24 with installed dependencies and transaction-capable MongoDB using `npm run verify:local`.
