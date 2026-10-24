# Privacy recovery

Starting point: saved v2.13.74. The missing v2.14 work was rebuilt; it did not survive the environment reset.

## Implemented

- Owner request creation reads the current active User, password, token version and Device in a transaction; the User/Device writes serialize simultaneous privacy changes and revocation. Consent withdrawal immediately disables marketing rather than merely recording a request.
- Independent reviewer changes use a current authenticated request, transaction-scoped `countryAdminAccess({workspace:false,country})`, authoritative staff grants, current Device, MFA policy and version fences. Approval, legal hold, correction, retry and restriction release reload the request and reject a stale source version.
- A correction completes only after explicit verified supported profile fields change. Email and phone remain in their existing verified account flows.
- Approved restrictions immediately persist `restrictionActive` and disable marketing/recent history/push/queued AI in the same transaction. Releasing a restriction never invents marketing consent or reactivates devices.
- Worker claims have random lease tokens, exact claim completion filters, expired-claim recovery, capped retries and reviewed recovery. Old workers cannot overwrite a newer claim or legal hold. Legacy approved deletion requests with a real reviewer remain processable.
- Deletion checks actual buyer orders/refunds/returns/disputes, unsettled payouts, owned stores/businesses, delivery/COD obligations, pending wallet funding, active subscriptions, reserved rewards, loyalty reversal debt and all owned ledger balances. Ledger mutation versions fence a concurrent posting. Retained settled orders do not permanently block deletion.
- Eligible deletion revokes active and invited store/business memberships, platform grants, mobile sessions, API clients, Devices and verification tokens; increments the account token version; anonymizes identity; removes optional addresses/cart/catalogue/notification/push/search/AI data. Financial records remain retained. Current/staged avatars are queued through the Customer agent's durable removal helper.
- Privacy exports use private encrypted files and current owner/status checks at download. Each file obligation is recorded before writing, so interrupted workers leave cleanup records. Expiry retains references on a storage failure for a later retry. Account deletion expires all export artifacts. Public/customer projections exclude merchant costs and internal support/moderation notes.
- Review follow-up: private export reads recheck current key, account status, hold and optional caller Device after storage I/O. Expiry updates match the exact old key, preserve scheduled cleanup tombstones for delayed writers, and back off per-object failures. Pending staff/store-team invitations are revoked on deletion, including email-address matches. Profile consent, newsletter subscription (including anonymous known-email requests), queued AI input and storefront search/recent history writes now serialize with restriction/deletion on the User record.
- `optional-processing.js` guards current active identities and active account restrictions. Guards cover newsletter resubscription (including submitting an account email anonymously), profile marketing opt-in, Country Admin campaign audiences and dispatch, Store broadcast audiences and dispatch, push queue/register/dispatch, personalized AI and queued AI, recent-history writes and search profiling. Public lexical search and non-personal popular-product reads remain available.
- Existing `admin.js` hold/approve calls now pass the current request. No approved UI layout was changed.

## Reviewer integration contracts (root owns Super Admin UI)

```js
approvePrivacyRequest(doc, actor, decision, { request, corrections? })
setPrivacyLegalHold(doc, actor, { active, reason, request })
retryPrivacyRequest(doc, actor, reason, { request })
releasePrivacyRestriction(doc, actor, reason, { request })
```

Supported correction keys are `name`, `publicName`, `location`, `bio`. At least one is required. The correction object is strict. Retry/release reasons require 10 characters; ordinary review/hold reasons require three. A reviewer cannot review their own request. A released legal hold leaves the request blocked pending a fresh reviewed retry. Retry accepts only export/deletion/restriction requests.

Root must expose actual correction fields, failed/blocked retry, and active restriction release in the Super Admin privacy UI; route-level workspace permissions/CSRF/private cache and error handling still apply. Existing Country Admin correction approval intentionally rejects an approval with no corrections instead of falsely marking it complete. Existing legacy rejection/cancellation routes have not been migrated to the new service in this subtask; root should route those actions through a fresh reviewed/owner service before treating the full operations UI as complete.

## Customer integration

```js
optionalProcessingUser(userId, { session, marketing: false }) // current active user or null
assertOptionalProcessing(userId, { session, marketing: false }) // user or 403
restrictedOptionalUserIds({ session }) // audience exclusion
```

Customer dashboard notification preferences should check `assertOptionalProcessing` before enabling offers/wishlist/club inside their existing fresh User/Device transaction. The Customer agent owns this integration. Avatar cleanup worker `processCustomerAvatarCleanup` must run in maintenance; Customer agent/root owns this hook.

## Validation

Agent ran only `git diff --check` successfully. No Node, DB, HTTP, browser, worker, provider or commit job was run by this agent.

Root-only runtime test file: `test/privacy-recovery-live.test.js`, with `CLASSIC_MART_LIVE_TEST_MONGO_URI` pointing to a loopback test Mongo replica set. It creates and removes an isolated random test database and uses actual model transactions, HTTP auth/CSRF/private export routes, encrypted files, version/Device revocation, independent correction, interrupted/failed claims, legal holds, restrictions, local-no-delivery push, broadcast dispatch, balanced wallet-ledger blockers, retained completed orders, active membership revocation and durable avatar removal. Files created by this test are individually cleaned. The test never calls an external provider; push points to a closed loopback port and must be cancelled before transport.

Root should also run existing Country growth, Seller growth, mobile/AI, customer account and worker suites to catch compatibility changes. The current review added regression source cases for Device revocation during export storage I/O, stale cleanup versus a newer ready export, a delayed interrupted writer, restricted notification/profile opt-ins, guarded cancellation and pending invitation revocation. The privacy fixture now provides required order fields, and its outer cleanup always disconnects even when imports, model initialization or database dropping fail. No runtime checks were run by this review agent. Actual SMTP/eSMS/Pesapal deliveries still require configured providers and separate verification; no claim of those deliveries was made here.

## Source follow-up, 24 October 2026

- Export collection reads now drain 100-record Mongo cursor batches. The complete projected payload has explicit 100,000-record / 32 MiB safety bounds; crossing either fails the job with a supervised-export explanation before publishing any partial download.
- Added every owned-market wallet top-up, owned ledger account and ledger posting, loyalty account/entry, reward, owned-order refund, subscription enrollment/charge, cart, product alert, search history and newsletter consent record. Ledger postings include only the account owner's lines, even when the same balanced transaction contains platform or merchant lines. Export fields omit counterparties, entry memos, transaction descriptions, checkout/provider tracking secrets, idempotency/session keys, merchant costs and internal loyalty/support/moderation notes.
- The live regression source now includes 205 ledger postings over two markets, 205 loyalty entries, 17 top-ups, 15 rewards and separate foreign-account records. It asserts complete IDs/counts, safe owned lines and internal/foreign exclusion. Current identity/caller/session token-version guards also have null, fractional, negative and unsafe-integer regression cases.
- The HTTP fixture owns one explicit loopback server for all signed-in and anonymous agents and closes its connections in outer cleanup. Anonymous newsletter requests obtain a real CSRF token from `GET /api/v1/cart`; the homepage does not provide CSRF markup.
- Only `git diff --check` was run for this follow-up. Root owns Node syntax, Mongo, HTTP and other runtime checks. The earlier four passing privacy leaves and one failed CSRF fixture reported by root predate these changes and do not validate this follow-up.
