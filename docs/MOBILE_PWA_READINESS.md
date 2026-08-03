# Mobile/PWA readiness

Classic Mart Stage 11 uses the installable PWA as the approved cross-platform mobile client. It deliberately does not claim a published Google Play or App Store binary.

## Network

- Public catalogue/product reads are short-cache API responses.
- Account, cart, checkout, order, payment and seller integration state stays server-authoritative and `no-store` where trusted state is involved.
- Mobile cart/order/payment routes call the same services used by the web application.
- API responses include `apiVersion` and `requestId`; list APIs use bounded cursor pagination.
- Seller inventory writes require an optimistic `If-Match` version and an idempotency key.

## Background/offline

- The service worker caches only the public shell/static assets and public product imagery.
- `/api`, `/account`, `/cart`, `/checkout`, `/track-order`, `/payments`, `/admin`, `/seller`, `/business`, `/operations`, AI and authentication routes are network-only.
- Offline navigation falls back to `/offline`; it never renders a cached successful payment or trusted stock quantity.
- Push and webhook delivery are worker/maintenance tasks with retry/failure states. An unconfigured push provider reports `providerConfigured:false` rather than fake delivery.

## Installability and accessibility

- Manifest has 192×192 and 512×512 PNG icons plus an SVG maskable icon.
- Apple touch icon/meta and standalone display are included.
- Install controls have visible labels, mobile viewport support and keyboard-usable buttons/links.
- Deep links are exposed through `/open/product/:id` and `/open/order/:id` plus configurable Android/Apple association endpoints.

## External integration security

- Mobile access/refresh tokens and seller API keys are opaque; only hashes are stored.
- Refresh reuse revokes the token family.
- Seller keys are scoped, expirable, quota-limited, rotatable and revocable.
- External writes use idempotency protection; inventory uses optimistic concurrency.
- Webhook secrets are encrypted, shown once, HMAC-sign deliveries and are rotatable/revocable.
- Webhook destinations are HTTPS-only, DNS/private-address checked and pinned to a vetted resolution for each delivery attempt.

## Release tests

`test/stage11-readiness.test.js`, `test/stage11-contract.test.js`, `scripts/check-project.js` and `scripts/audit-integration.js` form the Stage 11 gate. The target-machine `npm run verify:local` remains authoritative.
