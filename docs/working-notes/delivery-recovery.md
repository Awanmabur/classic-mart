# Delivery and Warehouse recovery

The reset restored baseline ae0936589e6ef1144ef8ba5495e2d40571b52ebc (v2.13.74); no lost v2.14 work is assumed present.

Ownership: Delivery profile, dedicated six-page workspace, current authority and scoped custody; logistics service integration; Warehouse carrier/delivery work queues and measured reporting. Root integrates shared mounts, role registry, shell and buyer pickup-code route, and runs all runtime checks.

Canonical pages: /delivery, /delivery/profile, /delivery/offers, /delivery/jobs, /delivery/tracking, /delivery/earnings. Legacy known Delivery dashboard aliases must redirect 308 after current authorization and preserve query strings.

Required invariants: current database identity/device/token/market; transaction write fences; source-bound offers; independent profile/COD review; actual private proof evidence and OTP custody; delivered Shipment persisted before Business completion reconciliation; real physical return intake; verified payout destination and reservation through Finance services. No generic customer screen for Delivery accounts.

Recovery is in progress. This note is a handoff record, not evidence that the functionality or verification is finished.

## Recovery source handoff (2026-10-23)

The dedicated six-page workspace, current Delivery authority, private evidence routes, independent Warehouse carrier/COD review, source-scoped offers, custody transitions, actual earning ledger and Finance payout integration are present. Warehouse measured reports and exports now have repaired aggregate syntax and use actual claimed/completed/due/handover timestamps.

This pass fixed stale offer versions (reissue and assignment increment versions), allocation races (Order, ReturnRequest, committed reservation, exact stock and active same-store Warehouse all participate in source write fences), changed Warehouse read scope, concurrent proof-evidence changes and carrier-verification evidence changes. Transit/delivery/return requires verified pickup, closing a return-kind failed/rescheduled path that could skip the buyer collection OTP. Failed collections can reschedule back to pickup. Each new attempt requires evidence after its actual pickup/attempt boundary.

Outbound return-to-sender rotates a receiving code disclosed only to scoped Warehouse operators. Carrier confirmation of `returned` requires that receiving OTP and a fresh private handover photo; it records physical custody without inventing a customer delivery, stock restock or delivery earning. Pickup ReturnRequest transport completion remains separate from Support receipt and authoritative Warehouse inspection. The Aftersales agent owns fixing `trust.markReturnReceived` to bind pickup receipt to the original committed stock/warehouse rather than an arbitrary store warehouse; `shipmentSource` now also returns `reservations` to support that integration.

`test/delivery-recovery-live.test.js` now authors real Product/Variant/Category fixtures, all six private shells, encrypted metadata-stripped evidence, stale-offer rejection, Warehouse handover and OTP lockout counters, real delivery earning, mismatched COD correction + independent receipt + separate Finance ledger, pickup return through buyer/receiver OTP and actual claimed inspection/restock, sender-return receiving proof, independently verified payout destination + available earning reservation/replay/rejection release, Device/token/grant revocation, measured report/export pagination, and optional Chromium desktop/mobile rendering. No external payout completion is asserted.

This agent ran no Node, database, HTTP, browser, provider, test or commit job. Root must run full syntax parsing and the focused live suites; authored assertions are not verification results. Remaining external integration: actual Pesapal/disbursement credentials and independently confirmed transfer evidence are required to validate successful external money movement. Shared app/auth/shell/mount/registry changes and commits remain root-owned.

Aftersales has implemented the pickup receipt allocation fix in `trust.markReturnReceived`. The Delivery live test now includes an older decoy warehouse/stock row for the same SKU and asserts inspection targets and restocks only the original committed allocation, leaving the decoy unchanged.

## Verification source correction (2026-10-24)

Root's initial serial run exposed a Warehouse authority fence defect: the inclusive User projection omitted `__v`, so subsequent writes compared an actual advanced User version with zero. `assertWarehouseAccess` now selects the actual version for its existing write fence. This affected independent carrier review and repeated physical return intake. The Delivery run's later unapproved-carrier and missing-custody failures followed the failed review; they require a fresh root-run suite after this fix. Root restored the shared `logistics.js` router mount in `src/app.js` for COD HTTP reconciliation. No runtime job ran in this agent.

Root's second serial run passed canonical profiles/pages, sender-return receiving proof, current authority revocation, measured reports/exports and actual desktop/mobile Chromium rendering. The first custody subtest then found a fixture expectation defect: an unapproved second carrier correctly failed the approval gate before reaching the foreign-offer lookup. The fixture now asserts that exact gate, independently verifies the second carrier through private identity upload and Warehouse review, and then asserts the foreign-offer denial leaves assignment/version unchanged. Root must rerun the Delivery suite to verify the remaining custody/COD/return/payout chain.

Root's next serial run passed the actual outbound custody, independent COD posting, payout reservation, authority checks, reports and desktop/mobile rendering. The remaining pickup-return leaf used the retired collection-code URL and correctly received its 307 redirect. The fixture now asserts that redirect, obtains the code from the canonical owned `/api/v1/customer/returns/:publicId/pickup-code` endpoint, and checks its exact shipment, private no-store policy and omission of the Warehouse receiving code. No service authorization or custody rule changed. Root must rerun the full Delivery suite to verify the downstream physical inspection/restock chain; this agent ran no runtime job.
