# Production Go/No-Go Checklist

Use this checklist for every Classic Mart release. A checked item should have evidence, not an assumption.

## 1. Source and change control

- [ ] Release version/notes match the code.
- [ ] No unreviewed emergency/manual database edits are required for normal startup.
- [ ] Current docs describe Pesapal, not an obsolete provider.
- [ ] High-risk model/index changes have migration/backfill coverage.

## 2. Secrets and environment

- [ ] Production secrets are in the deployment secret manager only.
- [ ] Any secret previously shipped in a developer archive has been rotated.
- [ ] Independent session/pepper/encryption/integrity/metrics/SIEM secrets configured.
- [ ] HTTPS `BASE_URL` and trusted proxy topology verified.
- [ ] `PRIVILEGED_MFA_REQUIRED=true`.
- [ ] `LAUNCH_COUNTRIES` explicitly set.
- [ ] Production malware scanning enabled.

## 3. Database and migration

- [ ] Fresh verified backup/PITR restore point exists.
- [ ] `DR_MAX_RPO_MINUTES`, `DR_MAX_RTO_MINUTES` and `DR_EVIDENCE_MAX_AGE_DAYS` are explicitly approved/configured.
- [ ] Provider PITR exercise records measured RPO within policy and unexpired evidence.
- [ ] Backup/replacement-environment restore records measured RTO within policy and unexpired evidence.
- [ ] Restore proof covers indexes/TTL behavior, immutable finance records, durable queues and required object/media/config/key recovery scope.
- [ ] `npm run db:verify` proves transaction support.
- [ ] `npm run migrate:plan` reviewed.
- [ ] Migration apply executed exactly once through controlled deployment if needed.
- [ ] Declared indexes created.
- [ ] Post-migration invariant scan shows no unexplained critical findings.

## 4. Pesapal

- [ ] Live consumer key/secret configured.
- [ ] Production Pesapal base URL configured.
- [ ] HTTPS IPN registered and `PESAPAL_IPN_ID` matches deployment.
- [ ] Controlled payment proves callback/IPN -> GetTransactionStatus -> ledger/order receipt.
- [ ] Controlled refund/reconciliation behavior verified for supported method.
- [ ] Finance understands marketplace payouts are separate external disbursement/reconciliation, not a Pesapal payout API.

## 5. Functional release gates

- [ ] `npm run check`
- [ ] `npm run security:check`
- [ ] `npm run frontend:audit`
- [ ] `npm run functionality:audit`
- [ ] `npm test`
- [ ] `npm run audit:integration`
- [ ] `npm run audit:concurrency`
- [ ] customer checkout/tracking/return smoke journey
- [ ] seller catalogue/order/return journey
- [ ] B2B immediate and credit journey
- [ ] support/trust/finance/logistics jurisdiction tests

## 6. Supply-chain/release artifact

- [ ] `npm audit --audit-level=high`
- [ ] CycloneDX SBOM generated and archived.
- [ ] sanitized ZIP built.
- [ ] release content/secret scan passed.
- [ ] ZIP SHA-256 recorded.
- [ ] production Docker image built from Node 24 and scanned by deployment platform/security tooling.

## 7. Operations

- [ ] At least one worker process deployed alongside web.
- [ ] `/health/live` and `/health/ready` green.
- [ ] private `/internal/metrics` scrape succeeds.
- [ ] Admin Health has no unexplained critical/high invariant alerts.
- [ ] SIEM receives security events.
- [ ] SMTP/SMS/push/webhook provider health verified for enabled features.
- [ ] restore/incident runbooks accessible to on-call team.
- [ ] `npm run launch:check` reports no expired or out-of-policy DR evidence.

## 8. Launch decision

**NO-GO** if any of the following remains unresolved: payment/ledger mismatch, refund accounting mismatch, invalid stock, data-scope leak, ambiguous duplicate payout, failed mandatory Node24/Mongo/concurrency gate, known high/critical dependency vulnerability, missing/stale/out-of-policy RPO/RTO recovery evidence, or unverified Pesapal production callback/IPN.
