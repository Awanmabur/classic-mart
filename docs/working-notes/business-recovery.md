# Business workspace recovery

The environment reset lost the uncommitted v2.14 implementation. This recovery starts from saved v2.13.74; earlier runtime results do not validate this replacement.

## Ownership and integration

- Business access/authorization/operations/workspace services, six page routes and partials, Seller B2B services/routes, Business and procurement models, Business fulfillment/documents belong to the Business recovery agent.
- Parent owns shared application mounts, dashboard shell/registry/auth integration, runtime jobs and commits. Financial recovery owns payments/money; Delivery recovery owns logistics and records Business delivery only after persisted actual shipment proof within the same transaction.
- Canonical pages: `/business/overview`, `/business/orders`, `/business/quotes`, `/business/invoices`, `/business/templates`, `/business/settings`. Authenticated legacy `/dashboard/business-*` paths redirect 308, preserving query strings.
- `hydrateBusinessAuthorization(request)` provides navigation context only. It must not persist a Customer identity as Business. Actual services always reload current User, session Device, accepted membership, organization and market.
- New canonical services replace the unmounted legacy `business.js`/router only after the parent checks remaining integration/audit imports. Missing commercial-policy snapshots must continue to fail closed.

## Security and commercial invariants

Mutations use current token/session/Device, MFA, accepted membership and capabilities inside transactions, with version fences and authoritative audit writes. Only owners appoint admins. Procurement approval is independent of its requester. Reviewed commercial policy is captured at submission and copied through approval, PO and marketplace Order. Supplier acceptance revalidates issuer token/current buying authority and exact SKU/quantity sources before stock reservation. Credit approval and exposure are independent. Recurrences create independently approvable requests, never purchases. Cancellation releases remaining approved commitment only. Actual verified delivery settles budget exactly once and creates private documents.

## Files and interfaces

Implementation, model additions, route mounts and authored test status will be appended as recovery progresses. No Node, database, HTTP, browser or provider runtime jobs are run by this agent; the parent executes verification.

## Recovery source handoff (2026-10-23)

Canonical Business services/pages and Seller B2B forms/routes are present. This pass repaired the overview aggregate syntax and actual invoice field sums. Existing contracts were source-reviewed for accepted membership without persisted User-role changes, owner-only admin appointment, independent procurement approval, current issuer authority, exact SKU/quantity/stock allocation, immutable commercial policy, independently reviewed credit and exposure, recurrence requests, budget release, and persisted private delivery proof before completion.

`test/business-recovery-live.test.js` now authors real Device/MFA fixtures, registered Seller store membership, procurement approval/quote/PO/stock/invoice flow, scoped private pages/documents, independent staff credit approval, recurrence pause on revoked source token, and an actual credit shipment flow through independent carrier verification, private identity upload, Warehouse pick/pack/dispatch, collection OTP, recipient OTP/private photo, exact-once budget settlement, credit ledger and delivery note. This is authored coverage, not a pass result.

Only source and diff whitespace inspection ran in this agent. Root must run the full JavaScript syntax gate, focused live suites with a transaction-capable isolated Mongo database, shared integration/audit checks, browser checks and commits. Provider payment/disbursement success is not claimed. Root owns removal/migration of old Business script/service imports, shared registry/shell/auth mounts and runtime. Super Admin recovery owns the concrete independent credit review screen/routing; the service is `reviewBusinessCreditTerms`.
