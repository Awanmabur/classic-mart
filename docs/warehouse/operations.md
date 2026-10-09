# Warehouse operations

The approved warehouse UI reads live stock, reservations, warehouse tasks,
parcels, discrepancies, waves and inventory movements. Original approved base
assets remain unchanged. The unused former warehouse template and stylesheet
have been removed.

## Routes

- `/warehouse`: operational overview and scoped summaries.
- `/warehouse/inventory`: stock, bins, condition quantities, transfers and counts.
- `/warehouse/receiving`: intake and put-away queues.
- `/warehouse/picking`: paid parcel preparation and owned pick waves.
- `/warehouse/packing`: picked goods, manifests and packing confirmation.
- `/warehouse/dispatch`: packed goods, handover tasks and printable parcel labels.
- `/warehouse/returns`: authoritative received-return inspection tasks.
- `/warehouse/reports`: movements, task/wave summaries and inventory reviews.
- `/warehouse/settings`: current locations, access and account-security links.
- `/warehouse/reports/export.csv`: scoped movement export, capped at 500 rows.
- `/warehouse/parcels/:publicId/label`: authorized packed-parcel Code 39 label.

Old `/dashboard/warehouse-*` URLs redirect permanently to the corresponding
canonical page. `/operations/logistics` and its old label/report URLs redirect
to the new routes. Retained warehouse mutation URLs, including `/complete`, use
the same guarded transaction service as the canonical forms. Their weaker
duplicate handlers were removed. The former preference toggles had no
operational effect; settings now expose authoritative information.

## Stock and fulfilment

Receiving and put-away operate on an existing stock item in the selected
warehouse. A transfer requires a permitted active destination in the same store
and country, and enough available stock after reservations and condition holds.
Physical stock changes and their movements commit with the completed task and
mandatory audit. Claim/release ownership and current revisions prevent another
operator from completing a stale form.

Cycle counts record an observation, not an immediate stock adjustment. A
different country or platform supervisor reviews a variance. Approval verifies
the original stock revision and every quantity snapshot. Reservation, release,
sale, cancellation and exchange updates advance stock revisions too, so a
reserve/release sequence cannot make an old count appear current. Historical
pending counts without a revision require rejection and a fresh count; no
snapshot is guessed.

Historical queued cycle-count tasks cannot be claimed or completed, because an
old observation must not become a fresh stock snapshot. Existing owned tasks
can be released; the operator records a new physical count from Inventory.

Warehouse fulfilment tasks are derived from actual paid or otherwise authorized
orders and committed reservations. Picking uses each reservation's real source
warehouse and remaining quantity, without deducting stock twice. Packing
requires all items to be picked; dispatch uses the recorded packing warehouse.
Operators see the parcel's SKU, item and quantity manifest before confirming.
Buyer tracking and seller preparation history update from the same transaction.
Historical preparation tasks with missing links are rebound only after their
actual parcel, paid order, shipment and committed reservations are verified.
Conflicting links require reconciliation rather than automatic repair.
Dispatch means ready for carrier pickup; delivery remains controlled by the
assigned carrier's backend proof workflow.

Buyer cancellation cancels unfinished outbound tasks, including historical tasks
linked only through the parcel or shipment. A wave completes when every task is
completed or cancelled; a wave containing another live order stays active.
Cancellation and preparation write the same root order to serialize competing
actions. Released waves retain their completed tasks and release unfinished work.

Return inspection consumes a received request's exact order line, stock item,
warehouse, quantity and task. Goods can be classified as good, damaged or
quarantined; replay cannot add them again. Receiving selects a warehouse in the
return's actual country. Inspection and the later trust/refund decision remain
separate stages.

## Access, privacy and performance

Operational access requires an active authenticated account, verified email,
onboarding and privileged MFA when enforced. Current platform grants govern
country and warehouse access, including multi-country staff. Writes fence the
account, grant and affected warehouse inside their transaction; revoked or
changed authority cannot be restored by replaying a receipt or stale role.
Forms require CSRF and a current target revision. Creation, waves and counts use
hash-bound durable action receipts; a reused key with a changed payload fails.
Audits and receipts commit with the action, so audit failure rolls it back.

Pages, labels and downloads use no-store caching and noindex headers. Projections
exclude internal database IDs, email addresses, payment/provider references,
proof codes, settlement details and product costs. CSV cells neutralize formulas
even after leading whitespace. Reports include condition and bin movement
snapshots and accept inclusive UTC date filters to narrow busy histories.

Principal tables use cursor pages of 25 rows. Summary counts aggregate the whole
authorized scope rather than the displayed sample. Count reviews have an
independent cursor, showing pending observations oldest first. Once the queue
is clear, reviewed history is available newest first. Fulfilment eligibility uses
batched context reads per candidate page; database work does not multiply by the
number of source warehouses. The write path revalidates authoritative state.
These bounds are not a production-scale latency measurement.

## Verification

Focused tests require an isolated loopback MongoDB replica set and system Chromium:

```sh
CLASSIC_MART_LIVE_TEST_MONGO_URI='mongodb://127.0.0.1:27019/classicmart_verification_test?replicaSet=classicmarttest' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node --test test/warehouse-operations-live.test.js test/warehouse-integrity-live.test.js
```

Local verification uses real MongoDB transactions, application sessions, MFA,
CSRF, COD checkout, stock reservations and browser forms. Notifications use the
development sink. This milestone does not verify Gmail, eSMS or Pesapal delivery,
production infrastructure, or the unfinished carrier dashboard.

Verified locally on 2026-10-09 with the complete branch: 433 canonical tests
passed, with zero failures, cancellations or skips. The public desktop/mobile
browser gate passed 54 checks with four intentional project-specific skips.
Project/import, security, frontend and functionality gates passed, as did the
stages 1–12 integration audit and 20-way concurrency audit. Warehouse browser
coverage executes real inventory, preparation and return-inspection forms on
390- and 1366-pixel viewports.
