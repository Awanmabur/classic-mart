# Classic Mart Dashboardless Baseline Design

## Goal
Create a clean Classic Mart baseline with every previous/recent dashboard and role-management workspace removed from both frontend and dashboard-specific backend routing, while preserving the production marketplace/domain backend so new dashboards can be built from scratch later.

## Approved scope
The user approved **Option B — surgical dashboard removal**.

### Remove completely
- Final 19 dashboard engine: `src/dashboard/**`, `src/routes/dashboard.js`.
- Dashboard assets and presentation: `public/dashboard/**`, `views/platform-dashboard.ejs`, `views/partials/dashboard-*.ejs`.
- Previous/recent role-management presentation: Admin, Seller, Seller Growth, Promoter Admin, Business Buyer, Finance/Money, Payout, Logistics/Warehouse/Delivery, Moderation/Trust operations, AI operations/admin/seller workspace, developer portal and other role workspace views/assets.
- Browser-only management route controllers whose only purpose is those removed dashboards/workspaces.
- Dashboard preferences, dashboard landing-page state, dashboard redirect helpers and dashboard-specific middleware coupling.
- Tests/docs/checkers whose only purpose is enforcing previous dashboard implementations.

### Preserve
- Authentication, verification, onboarding and account/profile/security/privacy flows.
- Public storefront, search, catalogue browsing, product detail, wishlist, compare, cart and checkout.
- Orders, receipts, financial documents and customer order tracking.
- Pesapal payment initiation/status/callback/IPN/webhook processing.
- Public/promoter attribution tracking required for existing orders/commission integrity.
- Public/customer support submission, customer returns/disputes/reviews, rewards, newsletter and Ask Classic customer features.
- Mobile/headless APIs that are not dashboard presentation.
- All reusable production models/services: stores, catalogue, inventory, orders, finance ledger, payouts, commissions, moderation, logistics, business buyer, support, AI, audit, security, jobs and integrations.

## Runtime behavior after reset
- `/dashboard` and every old dashboard/workspace page return 404; there is no placeholder dashboard.
- Successful login/signup verification/onboarding goes to `/` (or the requested safe public/account return path), never `/dashboard`.
- Account links go to `/account/profile` or another retained account page.
- No role selector, dashboard registry, dashboard page preference, dashboard asset or dashboard shell exists.
- Privileged-MFA classification no longer imports dashboard registry; retained privileged/API paths use explicit path rules.
- Existing database documents may still contain historical `preferences.dashboard` data, but the application schema/runtime no longer reads or writes it.

## Route boundary
### Entire browser-management route modules removed from app mounting
- `admin.js`
- `business.js`
- `logistics.js`
- `moderation.js`
- `seller.js`
- `seller-growth.js`
- `dashboard.js`

Reusable service/model code behind these modules remains.

### Mixed route modules trimmed to retained headless/public/core behavior
- `promoters.js`: keep `/r/:token` and `/api/v1/...`; remove HTML/browser management routes and promoter/admin workspace renders.
- `payments.js`: keep customer payment, Pesapal callback/webhook/IPN and headless `/api/v1/...`; remove `/finance`, `/money` and browser finance/payout workspace routes.
- `ai.js`: keep `/ask-classic` and public/customer `/api/v1/ai/...`; remove Seller/Promoter/Operations/Admin AI workspace endpoints.
- `trust.js`: keep public support submission, customer `/account/...`, customer/headless `/api/v1/...`, retained evidence download when customer-authorized; remove `/operations/...` management workspace routes.

## Presentation boundary
Delete every management workspace EJS/CSS/JS listed by the dashboardless gate. Retained account/public pages must not link to deleted dashboard URLs. Account privacy remains a normal account page and is renamed away from `privacy-workspace.ejs` to `account-privacy.ejs`.

## Safety and data preservation
- No models, migrations, production collections or reusable domain services are deleted solely because their UI is removed.
- No financial ledger/payment/webhook processing is deleted.
- No order/catalogue/inventory data is reset.
- No database cleanup/destructive migration is introduced.

## Verification contract
A dedicated dashboardless regression gate must fail if any of these return:
- `/dashboard` route/mount/literal navigation target.
- `src/dashboard`, dashboard registry/render/data/access files.
- `public/dashboard` assets.
- Final 19 or standalone role dashboard EJS/JS/CSS.
- dashboard preferences or `routeForPage` imports.
- old role/workspace GET render routes.

It must also prove retained core routes/services still exist and import successfully.
