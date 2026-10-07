# Classic Mart v2.13.74 — Final 19 Customer Dashboard Correction

This cumulative checkpoint builds directly on v2.13.73 and corrects the Customer dashboard against the uploaded **Classic Mart Unified Role Dashboard — Polished Final 19** reference rather than merely preserving its CSS.

## Visible reference corrections
- Restores the approved Final 19 Customer overview composition, including **Savings This Month**, the approved rewards card treatment, and the original right-column flow without the unapproved Recently Viewed block.
- Restores Final 19 product-card treatment for Wishlist and Categories using real catalogue rating, review, deal and price data.
- Restores Wallet amount chips, secondary Wallet action, payment panel and secure-note layout while keeping Pesapal as the real provider.
- Restores Profile completion/settings composition and the four-card Classic Club benefit presentation.
- Restores the Saved Addresses Edit control and binds it to the real owned-address update route.
- Restores the fuller Cart composition and wires Clear Cart and promotion-code controls to the existing authoritative cart APIs.

## Real backend additions
- Overview monthly savings is derived from paid/credit-due order discounts for the current month.
- Wallet CSV statement downloads from `/dashboard/wallet/statement.csv` using the authenticated customer's own wallet top-up history.
- Cart page also loads the authenticated customer wallet summary for the approved Wallet balance treatment.

No Seller or later-role dashboard has been introduced in this checkpoint.
