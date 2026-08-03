# Classic Mart Frontend Data & Functionality Matrix — v2.13.5

This matrix identifies the authoritative data source and mutation path for every major visible experience. Static editorial/legal wording may live in EJS or versioned CMS; operational counts, products, people, money, orders and statuses must come from MongoDB or explicit country configuration.

| Surface | Read source | Working actions / write path | Status |
|---|---|---|---|
| Homepage catalogue | Product, ProductVariant, StockItem, Category, Brand, Store, Review and Order read models through `getStorefront()` | Product preview, cart, wishlist, compare, search and category links use public IDs and server APIs | Complete |
| Homepage hero/journal | Published `CmsContent` revisions (`home.hero.*`, `press.article.*`) | Admin CMS revision → approval → publish/schedule/rollback | Complete |
| Homepage testimonials | Published `Review` rows with `verifiedPurchase=true`, joined to active users | Review submission/moderation remains server-authoritative | Complete; hidden when no qualifying reviews |
| Categories/brands/search | MongoDB catalogue response | Shareable filters/search URLs; no fixed shared category option list | Complete |
| Seller directory/profile | Verified Store plus approved published catalogue/review metrics | Follow and contact persist in CustomerCatalogueState/SellerContactRequest; customer/seller replies are server routes | Complete |
| Promoter directory/profile | Verified PromoterVerification, active User, approved live Campaign, PromoterLink, AttributionTouch, CommissionEntry and published campaign products | Follow, contact, promoter reply/resolve and customer reply persist in MongoDB | Complete |
| Wishlist/compare/recent | CustomerCatalogueState | Authenticated mutations use CSRF-protected storefront APIs | Complete |
| Cart/recommendations | Server cart plus live in-stock storefront catalogue | Add/update/remove, promo validation, checkout and recommendation add-to-cart | Complete |
| Checkout/order/payment | Cart, CountrySetting, ShippingZone, inventory reservations, Order, PaymentIntent and ledger | Server-recomputed totals, idempotent order/payment, verified provider/COD flows | Complete |
| Account/messages | User, Order, SellerContactRequest, PromoterContactRequest, support records | Replies, device/session actions, preferences and consent are server forms/APIs | Complete |
| Business buyer | BusinessOrganization/Member/Budget, ProcurementRequest, QuoteRequest, PurchaseOrder and eligible products/stores | Product/store selectors, approval, cancellation, quote and PO lifecycle | Complete |
| Seller catalogue/inventory/orders | Store ownership, Product/Variant/Media, StockItem/Movement, SellerOrder | Create/edit/submit/archive, stock actions and fulfilment are permission-scoped | Complete |
| Seller campaigns/growth | Seller-owned published/approved products, Campaign and SellerPromotion | Product checkboxes; backend ownership and publication/status checks; no raw product-ID entry | Complete |
| Promoter workspace | Verification, campaigns/applications, links, touches, commissions, content jobs and contacts | Verification, apply, link, content kit, appeal, reply and resolve | Complete |
| Delivery/warehouse | DeliveryPartner, DeliveryOffer, Shipment, Parcel, WarehouseTask, COD reconciliation | Controlled state transitions, OTP/proof and inventory operations | Complete |
| Returns/support/trust | ReturnRequest, Dispute, Review, EvidenceDocument, SupportTicket | Item-level returns, evidence, inspection, support actions and appeals | Complete |
| Finance | Ledger, PaymentIntent, Refund, PayoutAccount/Payout and ReconciliationRun | Refund order selector shows only eligible paid orders and remaining amount; payout four-eyes controls | Complete |
| Country/Super Admin | CountrySetting, feature flags, CMS, approvals, reports, exports, incidents and security collections | Country-scoped/four-eyes writes with audit records | Complete |
| AI workspaces | AI registry/prompts/jobs/evaluations/usage and approved business context | Human-approved jobs and provider-neutral evaluations | Complete |
| PWA/external API | Manifest/service worker, mobile sessions, API clients, idempotency and webhooks | Install, token refresh, API keys, webhook test/retry and push registration | Complete |

## Release enforcement

`npm run frontend:audit` rejects known fake/static operational data, raw-ID user forms, placeholder promoter flows, numeric product-ID coercion, fixed shared categories and missing frontend-to-server wiring. `npm run audit:integration` additionally verifies real MongoDB catalogue, CMS hero/article and promoter directory/profile data.

## v2.13.5 commerce interaction guarantees

| Interaction | Authority and expected behavior |
|---|---|
| Product preview quantity | Browser recalculates display immediately; server remains final authority at cart/checkout |
| Product preview variant | Selected variant changes price, stock, SKU and cart variant ID |
| Add to Cart | Waits for successful server mutation; no false success or forced redirect |
| Buy Now | Waits for successful selected-variant cart write before opening `/cart` |
| Multiple variants | Stored and rendered as separate variant-keyed cart lines |
| Cart quantity | PATCH targets the exact variant public ID and refreshes server totals |
| Final item removal | Server and browser both render an empty cart |
| Stock limits | Server rejects quantity above available stock with `INSUFFICIENT_STOCK` |
| Stock authority | Catalogue/product cards show aggregate product stock; preview/web/mobile cart show the exact selected variant stock |
| Wishlist bulk add | Sequential server mutations avoid optimistic-concurrency collisions |

`npm run functionality:audit` protects these interaction contracts in every release.

## Platform interaction wiring

`npm run functionality:audit` also walks all 54 EJS views. JavaScript-managed forms must be handled by scripts loaded on the same page, and non-submit buttons must have a real loaded handler or explicit safe browser action. Placeholder links and dead client-only checkout completion UI are rejected.
