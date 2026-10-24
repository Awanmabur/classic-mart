# Super Admin recovery

Starting point: saved v2.13.74. The missing v2.14 work was rebuilt after the environment reset.

## Implemented source

- All 21 destinations in `src/dashboard/super-admin-routes.js` have `/super` routes, current source lists, details, filters, stable cursor pagination and CSV export in the approved dashboard shell. Dashboard aliases preserve their query strings. Money keeps its source currency and minor units.
- Access requires a current active managed global Super Admin grant, verified identity, enrolled MFA and a current web Device. Reads recheck authority before returning; exports recheck it per record and stop after a revoked grant. Mutations additionally require a password/authenticator confirmation within 15 minutes and transaction-scoped User, Device, grant and market fences.
- Staff invitation acceptance creates an approval request rather than immediate access. Staff grants, personal customer account state, country policy, seller plan publication, CMS publication and feature changes require an independent administrator. Current target versions, requester authority and commercial source terms are checked again during application.
- Country forms expose typed market, reward catalogue and Club benefit fields. A policy digest detects real policy changes while permitting unrelated authorization fence increments. Inactive market records remain visible to the global workspace for reviewed reactivation.
- Seller plans have typed prices, cadence and entitlements; published terms are retained. A reviewed seller subscription request does not create a paid entitlement period. Charge reconciliation remains in the existing billing service.
- Privacy operations use the fresh reviewed APIs from `privacy.js`: real correction fields, approve/reject, legal hold/release, failed/blocked retry and active restriction release. Releasing a restriction does not recreate marketing consent.
- CMS revisions have escaped source previews, separate independent publication, future UTC schedules, cancellation, source digests and bounded revision history keysets. Security records expose reasoned current-source responses. Business credit decisions call the current requesting membership and bounded requested-terms review service.
- Review follow-up: source versions accept only a nonnegative integer or digit string. Blank, null, boolean and array inputs cannot silently become version zero.

## Integration

The current shared source mounts `super-admin-pages.js`, renders `super-admin-main.ejs`, exposes the Super Admin routes in registry/navigation, and uses the common privileged MFA classifier. These files are root-owned and were not changed by this review. No additional missing integration was identified statically. The unreferenced older `super-admin-dashboard.js` is not the current `/super` page loader.

## Validation

This review ran only `git diff --check`, which passed. It did not run Node, MongoDB, HTTP, browser, provider, worker or commit jobs. Root owns serialized runtime verification.

`test/super-admin-recovery-live.test.js` is the runtime regression suite. It requires `CLASSIC_MART_LIVE_TEST_MONGO_URI` for a loopback test replica set, creates a random isolated database, uses real HTTP login/MFA/CSRF and transactions, and destroys its HTTP transports and database afterward. Its cleanup always attempts disconnect if database removal fails. Coverage includes all 21 destinations, raw-role denial, malformed filters and versions, revoked export authority/Device, invitation acceptance and concurrent independent grants, policy/reward/Club application, seller plan publication without invented paid entitlement, privacy corrections/recovery/restriction release, CMS history/scheduling, feature publication, security source versions and business credit bounds.

Root's second runtime run passed the complete Super Admin suite: all eight subtests and the parent, covering all 21 destinations, CSV and revoked authority, staff access, market/reward/Club policy, seller plans, privacy, CMS/features/security and business credit. Its earlier three fixture failures were corrected: CSV expects the Category model's trimmed saved name, the direct seller-plan request supplies its selected current store, and the alert fixture supplies its required fingerprint. Evidence is recorded in `/tmp/classicmart-role-recovery-round2.log` for this workspace session. Scheduled CMS worker execution, external email/SMS delivery, real payment-provider reconciliation and browser visual fidelity require their separate root-owned checks.
