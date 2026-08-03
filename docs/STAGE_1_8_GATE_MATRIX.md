# Stage 1–8 release-gate matrix — v2.8.12

This matrix records the acceptance evidence used before Stage 9. It is intentionally narrower than the complete future blueprint: Stage 9–12 features are not represented as active. A green source-level row still requires `npm run release:check` on the target Node 24 environment with a transaction-capable MongoDB URI because the disposable MongoDB integration audit is the final execution gate.

| Stage | Required end-to-end gate | Concrete implementation/evidence |
|---|---|---|
| 1 | Signup → verification → onboarding → protected workspace; revoked devices/permissions/country enforced | `identity.js`, `account.js`, `auth.js`, email + phone tokens, device guard, `roles.js`, country middleware, audit log; production SMTP/SMS/secrets fail closed; Redis remains optional |
| 2 | Verified seller can create/submit/approve/publish/stock; cross-store access denied; unsafe media blocked | Seller verification/document routes, deferred multipart CSRF, malware scan + WebP re-encode, catalogue/variant/media moderation, warehouse/stock/lot/movement services, scoped store membership |
| 3 | Public catalogue is approved/in-country/sellable; search/filter/state loops persist server-side | Database candidate search + hydrated public read model, analytics click IDs, Q&A/reviews/alerts, server wishlist/compare/recent/follow state, seller messaging |
| 4 | Guest/customer order is one idempotent multi-seller order; checkout revalidates stock, delivery and tax | MongoDB cart, country settings, shipping zones/pickup points, server review, transactional reservation, `SellerOrder` split, order snapshots, tracked-order authorization helper |
| 5 | Payment cannot be browser-proven; ledger balances; retries/webhooks/refunds/payouts are idempotent/scoped | Hosted Flutterwave verification, HMAC webhook/dedupe, COD path, immutable double-entry ledger, item/store refund allocations, payout holds/four-eyes, reconciliation |
| 6 | Promoter link → server touch → order item attribution → payable/reversal/payout lifecycle | Verification, campaign review/application, random links/QR/coupon/UTM, self-referral/velocity controls, rule snapshots, commission ledger/reversal and payout advancement |
| 7 | Paid/confirmed seller parcels are actually picked/packed/dispatched/delivered with proof; COD reconciles | Delivery offers, per-seller parcels, encrypted+hashed OTPs, offline idempotent replay, executable warehouse tasks/movements, return-to-sender and driver/day COD ledger reconciliation |
| 8 | Return → receipt/inspection → finance refund or real exchange; disputes/support/reviews/trust are auditable | Policy snapshot eligibility, private evidence, return shipments, finance-only refunds, replacement order/seller order/shipment, SLA tickets, appeals, verified reviews, risk/enforcement |

## Cross-stage regression gates added in v2.8.2

- All JavaScript must parse.
- All local view assets must exist.
- Every static POST form must carry `_csrf`; multipart routes must verify deferred CSRF immediately after parsing.
- No Stage 1–8 authority may return to `localStorage`/`sessionStorage`.
- No DummyJSON, fake discount code, hard-coded express fee, remote Iconify runtime or CSS gradients.
- Home modal actions may not collect credentials/business data and discard it.
- Delivery city is persisted server-side and checked against configured zones.
- Help/Contact use the persisted support SLA intake route.
- Tracked-order email/phone grants authorize receipt, payment retry and cancellation consistently and only for the exact order.
- Cart strict-mode state and CSRF token access have dedicated regression checks.
- `release:check` must execute the real multi-seller MongoDB audit and high-severity dependency audit.

## Final machine gate

```bash
npm ci
npm run db:setup
npm run release:check
npm run dev
```

Do not begin Stage 9 if any command above fails.
