# Stage 11 gate matrix — Mobile/PWA and external APIs

Stage 11 extends the same Classic Mart authority to an installable cross-platform PWA, versioned mobile API and approved seller integrations. It does not create a second cart, order, stock or payment implementation.

| Blueprint requirement | Implementation | Release evidence |
|---|---|---|
| Manifest + installability + safe offline shell | `public/manifest.webmanifest`, 192/512 PNG icons, `/app`, `public/pwa.js`, `public/sw.js`, `/offline` | `test/stage11-readiness.test.js` |
| Cache only appropriate public assets | Explicit private-route denylist; authenticated/account/cart/checkout/order/payment/admin/seller/API routes are network-only/no-store | readiness + contract tests |
| Versioned mobile API/shared auth | `/api/v1/mobile/*`, opaque `cma_` access + rotating `cmr_` refresh tokens, hashed storage, token-family reuse revocation | contract tests + integration audit |
| Approved cross-platform client | Installable responsive PWA uses the same API/services. No native App Store/Play Store binary is falsely claimed | manifest/readiness tests |
| Push + deep links | Encrypted device token registry, provider-neutral push outbox, `/open/product/:id`, `/open/order/:id`, Android App Links and Apple Universal Links association endpoints | Stage 11 tests + maintenance worker |
| Seller API clients/scopes/keys/webhooks/rotation | Developer Portal, scoped one-time API keys, rotation/revocation/expiry, signed webhook endpoints, one-time signing secrets | developer portal + contract tests |
| Quotas/signing/replay protection | Atomic per-minute API quota, external-write idempotency keys, HMAC webhook signature/timestamp/event IDs, duplicate webhook delivery uniqueness | tests + integration audit |
| SSRF-safe outbound webhooks | HTTPS-only, private/local DNS rejection, DNS-pinned `https.request`, no redirect following, retry/dead-letter lifecycle | readiness test |
| Network/background/accessibility/store readiness | Request IDs, pagination, optimistic `If-Match`, provider-disabled honest push state, service-worker background notification handling, accessible install controls/icons/viewport and OpenAPI contract | `test/stage11-readiness.test.js` |
| Same price/stock/order/payment authority | Mobile routes call `getStorefront`, cart/checkout/order/payment services; seller API calls inventory/logistics services | integration audit + source gate |
| Offline never shows trusted stale success | service worker never caches API/account/cart/checkout/order/payment state and offline shell contains no payment/stock success state | service-worker tests |
| External clients scoped/revocable/audited | scope middleware, revocation/rotation, quotas, idempotency, `writeAudit` external events | contract + integration audit |
| Catalogue images reliably visible | seeded media resolves to bundled `/assets/products/*`; seller uploads remain protected `/media/catalogue/*`; remote Unsplash dependency removed | image readiness tests |

## Sign-off command

```bash
npm ci
npm run verify:local
npm run dev
```

Do not begin Stage 12 unless the Stage 1–11 MongoDB integration audit and dependency audit pass on the target machine.
