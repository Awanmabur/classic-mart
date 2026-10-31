# Production Operations Guide

## Process topology

Run web and worker as separate deployable processes from the same release/image.

```text
web:    node src/server.js
worker: node src/worker.js
```

The web process serves HTTP only. The worker owns scheduled/queued maintenance. Scaling web replicas therefore does not multiply scheduled jobs.

## Worker responsibilities

The worker processes, among other jobs:

- Pesapal provider-event inbox;
- email notification outbox;
- push outbox;
- seller webhook deliveries;
- recurring procurement;
- privacy requests/exports;
- business invoice aging;
- scheduled price/AI work;
- operational invariant scans.

## Atomic leases

Durable workers claim one job using a database compare-and-set (`findOneAndUpdate`) and write `lockedBy`/`lockedUntil`. Do not replace this with `find many -> later mark processing`; that reintroduces duplicate delivery under multiple workers.

A process crash is recovered after lease expiry. Retry counters/backoff are persisted. Permanently failed items remain visible as dead/failed operational work.

## Pesapal operations

- Register IPN only against the final HTTPS `BASE_URL`.
- Treat IPN/callback as a notification; inspect local `ProviderEvent` and the authoritative Pesapal transaction status when troubleshooting.
- Never manually mark an order paid from a screenshot or redirect query.
- Amount/currency/reference mismatch is a financial integrity incident.

## Admin Health / invariant alerts

Admin Health is a business-control surface, not merely server uptime. Typical critical/high findings include:

- verified payment missing ledger settlement;
- payment/order state mismatch;
- completed refund missing ledger/credit note;
- impossible return/refund counters;
- ambiguous/stuck payout;
- dead Pesapal/outbox/webhook job;
- stale worker lease;
- invalid inventory counters;
- B2B AR/invoice mismatch;
- chargeback missing reversal accounting.

Use alert states (`open`, `acknowledged`, `investigating`, `resolved`, `suppressed`) to record operator handling. Resolve only after the underlying invariant is corrected. If the defect recurs, the monitor reopens it.

## Metrics

When `METRICS_TOKEN` is configured, scrape `/internal/metrics` with a private bearer token. Metrics expose aggregate operational state and should not contain customer PII.

Recommended alerts include:

- HTTP 5xx/error-rate and latency thresholds;
- provider inbox backlog/dead events;
- refund/payout ambiguity;
- worker-cycle failure;
- support SLA breaches;
- inventory invariant failures;
- open critical operational alerts;
- recurring procurement backlog count **and oldest due age**;
- expired-reservation backlog count **and oldest overdue age**;
- scheduled-price backlog count **and oldest due age**;
- scheduled-campaign backlog count **and oldest due age**.

The corresponding Prometheus gauges include `classicmart_*_due` / `*_backlog` counts and `classicmart_*_oldest_age_seconds`. Bounded worker batches are acceptable only while those age gauges remain within the operating SLA.

Invariant scans use a persisted `InvariantScanCursor` per check. Each cycle processes a bounded batch, advances the Mongo `_id` checkpoint and wraps after a complete pass, so older historical records are eventually inspected instead of repeatedly scanning only the newest records.

Country Admin health is country-scoped. Global provider/outbox/payout infrastructure metrics are Super-Admin-only.

## Operational queues

High-volume Support, Logistics, Finance, Moderation and Seller queues use deterministic compound cursor pagination. Never replace those queries with arbitrary `.limit(100)` snapshots because older unresolved work can disappear from the operator surface.

## Financial operator rules

- Never edit immutable ledger or `FinancialDocument` rows directly.
- Never resend a payout in `unknown` state until the external disbursement has been reconciled.
- Refund/provider status and local ledger settlement must converge through the workflow, not manual database edits.
- Use stable provider/local references in incident notes.

## Security operator rules

- Staff jurisdiction is `operationalCountries`, not profile shopping country.
- High-risk staff/payout/chargeback/impersonation actions use four-eyes workflows.
- Termination/suspension or material access change revokes active sessions/token versions.
- Preserve audit/security-event evidence before remediation.

## Deployment operations

Use immutable release artifacts. Do not copy `.env`, `.git`, `.classic-mart`, runtime Mongo data, `node_modules`, logs or uploads into the deploy artifact. Run web and worker from the same version during rollout.

For migrations use plan -> reviewed backup -> apply -> invariant scan -> smoke verification.
