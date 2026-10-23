# Customer recovery, 22 October 2026

Base: saved GitHub `approved-dashboard-ui` commit ae0936589e6ef1144ef8ba5495e2d40571b52ebc (v2.13.74). Earlier uncommitted v2.14 changes are unavailable; this is new work.

Ownership: customer dashboard reads/history, address editing, exact cart-to-wishlist move, private avatar controls; privacy worker/restriction work delegated to privacy_recovery. Root integrates app/shared dashboard and runs runtime checks. Financial services and checkout core are owned elsewhere.

Initial verified gaps: histories silently stop at fixed limits; wallet CSV exports only twelve top-ups and omits ledger activity; cart Move to wishlist is a plain link; profile photo has no working upload; Delivery/Business/SuperAdmin live workspace gaps handled by other agents.

Implemented customer keyset histories with signed owner/filter/market bindings; complete owned-market wallet ledger CSV with opening/running/closing balances; transactional exact cart-variant movement to wishlist; complete delivery-address editing/default repair; private encrypted, sanitized 320 × 320 avatar uploads with durable cleanup; notification mutation transactions and restriction checks. Customer writes reload the current User and Device/mobile session and fence their versions in the same transaction.

Review follow-up: `currentCustomerAccess(write:true)` now advances the returned actor version after its fence. Account profile changes use this current actor in a transaction, including the marketing restriction guard and audit. Privacy cancellation uses the guarded service; private export downloads recheck current access around storage and immediately before sending. Customer dispute mutations now share the same current Device fence. Restriction/deletion now serialize with newsletter subscription, queued AI input and storefront search/recent history writes; deletion also revokes pending staff/store-team invitations.

Current validation: `git diff --check` passed during static review. No Node, database, HTTP, browser, worker, provider or commit job was run by this review agent. Root owns serial runtime verification. `test/customer-recovery-live.test.js` requires both a running isolated Simple Login app in `CLASSIC_MART_LIVE_BASE_URL` and its loopback test Mongo URI for the first five cases; skipped cases are not validation. The additional avatar cleanup case requires the test Mongo URI and local media storage.
