# Classic Mart v2.13.5 — Mobile Variant Authority & Stage 11 Integration Repair

v2.13.5 is a cumulative patch over v2.13.4. It preserves the verified product-preview, variant-cart and platform interaction work while correcting the Stage 11 integration audit for multi-variant catalogue stock.

## Root cause

The published product read model intentionally exposes two stock levels:

- `product.stock`: aggregate sellable stock across all active variants;
- `product.variants[].stock`: sellable stock for one exact variant.

The mobile cart line is variant-specific and correctly returned the selected variant's stock. The Stage 11 audit incorrectly compared that value with aggregate product stock. A product with 22 units on the selected variant and 4 units on another variant therefore produced the invalid comparison `22 !== 26`.

## Correction

- Mobile audit cart lines are now found by selected variant ID, not only product ID.
- Price is compared with the exact published variant price.
- Availability is compared with the exact published variant stock.
- SKU is compared with the exact published variant SKU.
- Product-level aggregate stock is separately verified as the sum of all published variant stock.
- Added a Stage 11 regression test that rejects comparisons between cart-line availability and aggregate product stock.
- Strengthened the project release checker to require the selected-variant authority assertions.

## Preserved guarantees

- Web and mobile carts continue to use the same server-authoritative checkout service.
- Product cards may show aggregate stock across variants.
- Preview/cart lines show and enforce stock for the selected variant only.
- Multiple variants remain separate cart lines.
- Requested quantities above selected-variant availability remain rejected.
