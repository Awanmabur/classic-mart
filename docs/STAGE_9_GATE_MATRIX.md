# Stage 9 gate matrix — Admin, CMS, analytics and growth

| Blueprint gate | Implementation | Verification |
|---|---|---|
| Country Admin cannot access another country | Country-scoped queries and `ensureAdminScope`; cross-country feature/admin requests rejected | Stage 9 contract + MongoDB integration audit |
| Content scheduled/versioned/reversible | `CmsContent.revisions`, active/scheduled versions, approval-controlled publish/rollback, maintenance activation | Stage 9 contract + MongoDB integration audit |
| Feature rollout limited by country/role/percentage | `FeatureFlag` plus deterministic SHA-256 bucket and schedule checks | Stage 9 contract + MongoDB integration audit |
| High-risk change requires reason/approval | `ApprovalRequest`, reason validation, different-decider four-eyes rule | Stage 9 contract + MongoDB integration audit |
| Attention centres use real data | Admin counts query approval/support/trust/payout/catalogue/verification/incidents with country scope | Project check + route tests on release machine |
| CMS reaches public pages | Published CMS is resolved by country with global fallback for home/help/legal pages | Project check + Stage 9 contract |
| Loyalty/referrals depend on verified commerce | Payment/COD completion calls growth service; idempotent entries prevent duplicates | Stage 9 contract + integration audit |
| Campaigns respect consent | Outbox only receives active accounts with `consents.marketing=true`; scheduled campaigns wait until due | Stage 9 contract + integration audit |
| Exports protect privacy | Fixed allow-list columns, approval, audited download, 24h expiry and file deletion | Stage 9 contract + integration audit |
| Impersonation is safe | Approval required, single-use, 30-minute expiry, visible banner, all mutations blocked, start/stop audited | Stage 9 contract + project check |
| Platform health respects scope | Country Admin gets country payment/reconciliation health; global queue/provider internals restricted | Stage 9 contract |
| Stage is end-to-end | The cumulative real Stage 1–10 MongoDB audit retains the Stage 9 administrative assertions alongside later AI checks | `npm run audit:integration` |
