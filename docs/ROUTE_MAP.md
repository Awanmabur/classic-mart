# Classic Mart v2.13.71 route map — Customer dashboard checkpoint

This checkpoint adds the first approved Final 19 dashboard on top of the dashboardless v2.13.70 core. Only the Customer dashboard is exposed. Seller and every later role-management dashboard remain absent until separately approved.

## Customer dashboard

| Method | Route | Access | Authority |
|---|---|---|---|
| GET | `/dashboard` | Verified/onboarded Customer | Redirects to Customer overview |
| GET | `/dashboard/:page` | Verified/onboarded Customer | One of the 13 approved Customer page IDs |
| POST | `/dashboard/addresses` | Customer | Owned address creation |
| POST | `/dashboard/addresses/:id` | Customer | Owned address update |
| POST | `/dashboard/addresses/:id/default` | Customer | Atomic default-address invariant |
| POST | `/dashboard/addresses/:id/archive` | Customer | Owned address archive |
| POST | `/dashboard/wallet/top-up` | Customer | Pesapal-hosted verified wallet top-up |
| GET | `/dashboard/wallet/return` | Customer | Top-up verification and ledger credit |
| POST | `/dashboard/notifications/:id/read` | Customer | Owned notification read state |
| POST | `/dashboard/notifications/read-all` | Customer | Owned notification bulk read |
| POST | `/dashboard/notifications/preferences` | Customer | Customer notification preferences |

Approved Customer page IDs: `dashboard`, `orders`, `wishlist`, `addresses`, `rewards`, `wallet`, `returns`, `support`, `profile`, `categories`, `cart`, `notifications`, `club`.

## Identity and ordinary customer account

| Method | Route | Access | Authority |
|---|---|---|---|
| GET/POST | `/signup` | Guest | MongoDB user creation |
| GET/POST | `/login` | Guest | Argon2id + server session |
| GET/POST | `/verify-email` | Signed in | Hashed expiring verification token |
| GET/POST | `/forgot-password` | Guest | Generic recovery response |
| GET/POST | `/reset-password` | Recovery session | One-use recovery token |
| POST | `/logout` | Signed in | Session/device revocation |
| GET/POST | `/onboarding` | Verified | Server-side account onboarding |
| GET/POST | `/account/profile` | Verified | Profile/preferences |
| GET | `/account/orders` | Verified | Owned order history |
| GET/POST | `/account/security` | Verified | Password/device controls |
| GET | `/account/messages` | Verified | Customer messages |
| GET/POST | `/account/privacy` | Verified | Privacy controls |
| GET | `/account/rewards` | Verified | Loyalty/referral history |
| GET | `/account/apps` | Verified | Connected apps |
| GET/POST | `/account/returns` | Verified | Returns/support/trust customer flow |

## Public storefront and commerce

`/`, `/products`, `/categories`, `/search`, `/sellers`, `/cart`, `/wishlist`, `/compare`, `/checkout`, `/track-order`, `/payments`, `/about`, `/help`, `/contact`, `/returns`, `/shipping`, `/privacy`, `/terms`, `/cookies`, `/careers`, `/press`, `/promoters`, `/app`, `/offline`, and Ask Classic remain public/customer-facing surfaces as authorized by their route middleware.

Key server-authoritative APIs retained include:

- `/api/v1/storefront/*` — published catalogue, product/seller discovery and customer catalogue state.
- `/api/v1/cart/*` and checkout/order APIs — cart, checkout review, order placement and authoritative pricing/stock validation.
- `/api/v1/orders/:orderId/payment-intents` and `/api/v1/orders/:orderId/payment` — payment intent/state, including internal Classic Wallet when the authenticated Customer selects it.
- `/payments/return` and `/webhooks/pesapal` — Pesapal return/IPN handling with provider verification.
- `/r/:token` — promoter attribution.
- `/api/v1/ai/*` and `/ask-classic*` — customer AI/search experiences.
- `/api/v1/mobile/*` — mobile commerce APIs.
- `/api/v1/seller/*` — scoped external seller integration API; this is not a browser dashboard.
- `/openapi/v1.json`, `/.well-known/*`, `/open/product/:id`, `/open/order/:id` — mobile/external integration contracts.
- `/health/live` and `/health/ready` — service health.

## Dashboard staging boundary

This release must not expose Seller, Promoter, Business Buyer, Finance, Support, Warehouse/Logistics, Moderator/Trust, Country Admin or Super Admin dashboard presentation. Their domain models/services may remain where they are part of marketplace authority, but their dashboard UI/router integration is deferred until the corresponding checkpoint is explicitly approved.
