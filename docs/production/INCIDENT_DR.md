# Incident, Reconciliation and Disaster-Recovery Runbook

## Severity examples
- **Critical:** verified payment missing ledger, chargeback missing reversal, invalid stock counters, data-scope breach, duplicate/ambiguous external payout.
- **High:** completed refund missing credit note, dead seller webhook/outbox, serious SLA/backlog degradation.

## First actions
1. Preserve evidence and request IDs.
2. Stop the smallest affected workflow (for example payout submission) rather than taking the marketplace down unnecessarily.
3. Inspect Admin -> Health invariant alerts and provider/reconciliation queues.
4. Do not manually edit immutable ledger/financial documents.
5. Reconcile provider truth using stable Pesapal/external references.
6. Record every operator action in the incident timeline.

## Pesapal mismatch
For callback/IPN uncertainty, query Pesapal transaction status using the stored tracking ID/reference. Never mark paid from browser/IPN payload alone. If provider says paid and local settlement failed, leave/retry the durable provider event until the idempotent local transaction succeeds.

## Payout unknown
Do not resend. Obtain the external disbursement status/reference first, then a different Finance operator reconciles paid/failed. The payout hold keeps the liability unavailable during ambiguity.

## Recovery policy
Classic Mart requires explicit production recovery objectives instead of an informal backup promise:

- `DR_MAX_RPO_MINUTES` — maximum accepted data-loss window. The launch gate requires measured provider PITR evidence at or below this value.
- `DR_MAX_RTO_MINUTES` — maximum accepted restoration/rollback time. Backup-restore and rollback evidence must be at or below this value.
- `DR_EVIDENCE_MAX_AGE_DAYS` — maximum age of recovery proof. Passed recovery evidence expires automatically and launch readiness becomes NO-GO again.

The values must be approved by operations/business owners for the actual deployment. Changing an environment value does not prove the new objective; a fresh drill must still meet it.

## Backup architecture
Production recovery evidence must cover all authoritative material, not only Mongo documents:

- encrypted provider-managed MongoDB snapshots and point-in-time recovery where supported;
- an off-account/off-region recovery copy when the deployment risk model requires it;
- object/media storage backup or replication, including product/evidence documents required for disputes and accounting;
- deployment configuration and infrastructure definitions;
- encryption, HMAC/pepper and other security-key recovery from the approved secret-management process (never from the source ZIP);
- audit/security-event retention required by policy;
- declared Mongo indexes and TTL behavior after restore;
- provider references, immutable ledger transactions, financial documents and reconciliation state;
- worker/inbox/outbox durable queues held in MongoDB.

Redis is disposable acceleration/coordination state and must never be the only copy of an authoritative business fact.

## Logical restore drill
Run `npm run backup:drill` against a dedicated database whose name ends in `restore-test`.

The drill:

1. streams critical Mongo collections in bounded batches;
2. recreates and verifies collection indexes;
3. compares restored document counts;
4. records measured logical-restore RTO;
5. emits structured JSON with `evidenceType=logical_restore` and `pitrProven=false`.

Set `BACKUP_DRILL_EVIDENCE_PATH` to an **absolute `.json` path outside the application tree** to persist the structured evidence with restrictive file permissions. This prevents drill output from accidentally entering a release archive.

A logical restore drill **does not prove provider PITR and does not prove RPO**. The `pitr` launch gate requires separate provider/infrastructure evidence with a measured recovery point.

## Provider restore / PITR exercise
At least once within `DR_EVIDENCE_MAX_AGE_DAYS` (and after material recovery architecture changes):

1. choose an approved source snapshot/recovery point;
2. restore into an isolated replacement environment;
3. record source recovery-point time, restore start/end time, provider operation/reference and scope;
4. measure actual RPO and RTO;
5. verify indexes and critical invariants;
6. verify ledger balances/financial documents against provider references;
7. verify application startup, migrations, worker queues and authorization scopes;
8. verify required object/media and configuration/key recovery through their own approved procedures;
9. destroy or quarantine the isolated restore after evidence is retained.

Super Admin records the measured evidence under **Security & Launch**. Evidence that is stale or exceeds policy automatically blocks `npm run launch:check`.

## Deployment rollback exercise
Rollback proof must demonstrate a safe immutable application/container rollback and measured RTO. Database schema compatibility must be assessed independently; never roll application code backward across an incompatible destructive migration without the documented recovery procedure.

## Recovery validation
A backup is not considered proven until a replacement environment can be restored and checked. At minimum verify:

- authentication and scoped privileged access;
- orders, stock, seller orders and shipments;
- payment intents/provider references;
- ledger balance invariants, refunds, payouts and chargebacks;
- immutable business/financial documents;
- indexes/TTL indexes;
- audit/security evidence;
- durable provider inbox/outbox/worker queues;
- media/evidence availability where required by the recovery scope.

Any unexplained mismatch is a launch blocker and incident until reconciled.
