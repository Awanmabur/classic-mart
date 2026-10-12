# Support workspace contracts

The nine approved Final 19 Support pages use real server records. Only the
current primary Support role can render this workspace. A managed staff account
stored as Customer still lands in Support from its authoritative active grant.
The Customer's shopping Support page remains at `/support`.

| Page | Canonical route | Connected behavior |
| --- | --- | --- |
| Overview | `/support/overview` | Complete scoped backlog, public response timing, valid requester ratings, SLA observations and calendar trends |
| Ticket Queue | `/support/queue` | Versioned claim/release/transfer, priority/queue changes, public replies/private notes, resolve/close/reopen and factual reply macros |
| Customers | `/support/customers` | Explicit masked lookup; contact disclosure requires a current assigned active case, a documented purpose and atomic audit |
| Orders | `/support/orders` | Original order/payment/fulfilment context and staff-created help cases retaining the actual requester |
| Returns | `/support/returns` | Policy decision, physical receipt/inspection state, exact Finance referral and real inventory-backed exchanges |
| Disputes & Escalations | `/support/escalations` | Assignment, documented review, actual departmental referral, customer updates, evidence-backed resolution and independent appeal review |
| Reviews | `/support/reviews` | Saved order-linked review context and durable moderation referral; Support cannot publish or reject reviews |
| Reports | `/support/reports` | Full scoped summaries, tickets, queues and anonymous validated CSAT; bounded record pages and streamed CSV |
| Settings | `/support/settings` | Five approved sections: profile, assigned market details, working preferences, notifications and personal security |

Legacy `/dashboard/support-*` links redirect with query parameters. Search fills
the approved header; there is no role selector. Base Final 19 assets and marketing
styles remain unchanged. Additions are scoped to live Support controls and the
Warehouse detail-row correction. Desktop spacing, four metrics, the 292px aside,
mobile spacing and five settings tabs are checked against the approved layout.

## Conversations and privacy

Creation and Customer replies use current account, token, active market and exact
owned order checks in transactions. Public guest contacts are encrypted at rest.
Private notes never enter Customer ticket/dispute projections or reply delivery.
Return/refund Customer projections omit staff identities, private Finance referral
notes, provider messages and disbursement references. Contact lookup returns
masked values; exact email/phone/public ID searches use their existing indexes.
Names require an explicit search of at least three characters.

Contact disclosure fences the active requester, linked order, staff identity,
grant, country and ticket. A final joined check after header/sidebar loading
rejects assignment, lifecycle, contact or scope changes before returning contacts.
Customer appeals release assignment, retain the prior public outcome and require
a different reviewer for the next decision.

Staff mutations validate saved record versions, current grant/country coverage,
verification and configured authenticator enrollment. Audit failure rolls business
records, account/grant/market fences and queued notifications back together.
Private pages use `no-store` and `noindex`; exports recheck access while streaming,
respect backpressure and neutralize spreadsheet formula prefixes.

## Physical returns and Finance

For a drop-off return, an authorized receiving Warehouse uploads a sanitized
image for the exact original line and receiving store. The approved
`/warehouse/returns` form records that receipt and creates actual inspection
tasks. Support cannot invent receipt or inspection. Pickup returns require the
verified delivered return shipment. Receipt choices use one bounded aggregation,
with the latest 20 per exact line; inaccessible, unattached or wrong-owner images
are excluded. Staff receipt reads require current warehouse, country, grant and
MFA access even after an old grant is revoked. The actual return buyer retains
access to their own accepted case evidence.

Completed inspection determines the original paid line allocations. Support
refers the case to `/finance/refunds?return=<public ID>` without moving funds.
Finance reservation binds one Refund to that Return atomically, using
`return-refund:<public ID>`, exact inspected amounts and saved versions. An
independent manual completion or verified provider outcome posts the real ledger,
credit note, quantities, seller case outcome and buyer notification together.
Failed or unconfirmed provider delivery never becomes a completed return.

`npm run migrate:plan` reports pending historical unbound Return refunds and
duplicate imported bindings using public IDs only. `--apply` refuses ambiguous
records before changing data or building indexes. Reconcile the original goods
and financial evidence before production rollout; migration does not invent
bindings, reset statuses or rewrite history. No production migration ran here.

## Preferences and delivery

Saved default country, queue, reporting period and landing page affect actual
reads and login. Density is scoped to Support tables. The idle reminder uses real
elapsed inactivity and does not replace server session expiry. Urgent tickets
use 4 hours, high 12 hours, normal/low 48 hours consistently across creation paths.

Priority/escalation alerts honor current grants and saved preferences. Weekly
report opt-in drives the actual maintenance/outbox worker: Monday at 08:00 in the
selected market's calendar, or UTC for a combined scope. Delivery checks the
current recipient, token, email, grant, MFA and scope again. SMTP retry, cancellation
and development sinks have separate recorded outcomes; a log sink is never
reported as external delivery.

## Verification and limits

The expanded ten-file Support group passed 122 entries across the final runs with no failures or skips,
including real authenticated HTTP, CSRF, genuine MFA, role/country isolation,
transaction rollback, contested claims/reservations, private response boundaries,
all nine pages at 1366px/390px and the physical return-to-refund workflow.
The final guard/contract group covers 169 entries; its corrected handoff and
source-contract rerun passed all 24 entries, including four Customer read
performance checks. The 114-entry selected regression group passed across its
final runs. The full Stage 1–12 integration and native 20-way concurrency audits
passed. Project/import, static security, frontend and functionality gates passed;
`npm audit` reported zero vulnerabilities. Reruns and overlapping groups are not
added to the distinct Support count.

Local checks use a loopback MongoDB replica set, generated process-local test keys,
system Chromium and development provider sinks. Gmail, eSMS Africa and Pesapal
credentials are absent from this cloud runtime, so real delivery/settlement remains
unverified. No production migration, production load certification or independent
penetration test was performed. The approved palette's existing strict contrast
limitation remains documented in `docs/public-accessibility.md`; this stage does
not claim absolute security, full WCAG compliance or a passing broad release gate.
