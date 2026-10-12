# Connected Finance workspace

The approved reference remains `dashboard-preview/final19`. Its base styles,
scripts and images remain unchanged. Overview uses the approved chart and
priority layout; seven operational pages retain four metrics, the table,
292px desktop side panel and workflow area. Settings retains the five original
profile sections. Real records, statuses and saved actions replace previews.

| Page | Canonical route | Persisted data and operations |
| --- | --- | --- |
| Overview | `/finance/overview` | Actual captured payment counts, completed refunds, paid payouts, recorded exceptions, scoped calendar trend and summary export |
| Payments | `/finance/payments` | Verified order/payment references, status filters, full totals and export, independent Pesapal status verification |
| Refunds | `/finance/refunds` | Exact refundable balance, immutable line allocations, reservations, provider requests and independent manual completion |
| Payouts | `/finance/payouts` | Destination review, real reserved funds, approval/rejection, one transfer attempt, audited destination reveal, confirmation, uncertain outcomes and settlement; commission appeals |
| Reconciliation | `/finance/reconciliation` | Provider runs, matched notification replay, receipt-backed COD reconciliation and saved run history |
| Disputes | `/finance/disputes` | Actual reversed exposure, independent review/resolution and verified provider proof; estimates remain unposted |
| Reports | `/finance/reports` | Complete totals grouped by country/currency, payment/refund/payout/ledger/reconciliation records and CSV |
| Audit | `/finance/audit` | Scoped immutable Finance evidence with safe filters and export |
| Settings | `/finance/settings` | Personal fields, default country/calendar/landing page, real payment configuration, alerts/weekly report preferences and personal security |

Legacy `/dashboard/finance-*` links redirect with HTTP 308 and preserve query
parameters. `/finance` rechecks Finance access before redirecting to Overview.
All nine navigation entries are available. Authenticated pages and exports use
private `no-store` and `noindex, nofollow, noarchive` headers.

## Authorization and money

The server reloads account status, token version, verification, onboarding,
authenticator enrollment, primary workspace and current authoritative platform
grant. A managed Finance grant works even when the stored identity role is
Customer. Customer, Seller, Promoter, Admin and Super Admin accounts cannot
render the Finance workspace. Existing administrative money APIs retain their
own Finance permission checks. There is no public Finance signup or role picker;
operators receive authorized staff access through the existing grant workflow.
Personal account pages preserve the authorized workspace and security continuation.

Operating countries come from current grants or the existing assigned scope.
Their active configuration supplies settlement currency and reporting calendar.
Shopping country/currency preferences cannot select another country's funds.
Amounts from different currencies remain separate. Page totals aggregate every
matching record; bounded keyset pages do not silently limit totals. Long exports
recheck current authorization before further rows, stop on grant/token/market
changes and neutralize spreadsheet formula cells. Provider events are shown
only when linked payment and order references prove their country scope.

Money decisions run in transactions with current account, grant, country and
record fences plus atomic audit. Invalid or stale input fails before success.
Refund amounts are exact integers, cannot exceed the original captured balance,
and partial/repeated refunds require immutable order-line allocations. Manual
completion requires another current operator. Existing owner-authorized,
pre-fulfilment Customer cancellation still refunds the same customer's wallet.
Pesapal outcomes must match the original financial/reference evidence; mismatched
statuses cannot overwrite captured money. Chargeback reversal evidence, intent,
order, documents and ledger changes commit together. Unposted commission
estimates cannot invent withdrawable funds.

Payout destination review, approval, submission and final settlement have
independent operator rules. A genuine ledger reservation is required. Submission
claims one immutable attempt; it does not simulate a provider transfer. Full
destination details appear only on an audited CSRF-protected POST for the
operator who claimed the transfer. Normal HTML, JSON and CSV show masked details.
Uncertain transfers retain their funds until evidence resolves the same attempt.
One external provider/reference cannot settle two payouts, including concurrent
transfers in different countries. Before applying the production migration,
`npm run migrate:plan` reports historical reference collisions using public
payout IDs only. `--apply` stops before mutation when collisions exist; operators
must resolve them using external evidence. No historical duplicates are deleted.
Destination review is independent manual review, not an automatic bank ownership
check. Production migration/index execution has not been performed here.

## Communication and delivery

Priority and escalation preferences control ordinary in-app Finance alerts to
currently authorized country operators. Weekly reports queue once per operator
and week on Monday during 08:00–08:59 in the selected country's time zone, or UTC
for an all-country report. Bounded persisted scans progress beyond the first
batch. The report stores actual aggregate results, transaction audit and outbox
evidence. Delivery rechecks opt-in, email, token, grants, MFA and market defaults;
revoked delivery is cancelled. Development sinks are recorded as
`development_sink`, never as successful external mail. Provider failures retain
retry state. Email delivery has ordinary outbox retry semantics and cannot
promise exactly-once SMTP receipt.

## Verification

Results on 2026-10-12 (Africa/Kampala):

| Check | Result |
| --- | --- |
| Seven Finance suites, including all nine destinations at 1366px and 390px | 79 checks passed; no failures, cancellations or skips |
| Final scoped guards plus effective-role MFA rerun | 58 checks passed; includes corrected root-route denial after grant revocation |
| Final provider reversal and reconciliation rerun | 26 checks passed; no failures or skips; includes atomic reversal rollback and linked-event country proof |
| Existing role, Customer wallet/payment API, Seller/Promoter finance and grant/MFA regressions | 66 checks passed after installation; no failures or skips |
| Existing payout, Finance, referral, attribution and MFA contracts | 33 checks passed; no failures or skips |
| Stage 1–12 isolated MongoDB integration audit | Passed with real MFA, COD, payout reservation/release and refund services; local delivery sinks |
| Native collection concurrency audit | Passed under 20-way races; authenticated service races are tested separately above |
| Project/import, static security, frontend and functionality gates | Passed |
| Dependency audit | Zero reported vulnerabilities |
| Complete saved installation script | Executed successfully; pinned `npm ci`, project gate and helper generation verified |
| Verification MongoDB | Writable primary; zero container restarts |

All 178 distinct targeted Finance, regression and contract checks passed across
the final runs. Guard/reversal reruns strengthen affected checks and are not
added again to this count.
Initial fixture corrections supplied required unique order keys, reservation
expiry, staff approval references, membership fields and genuine payment ledger
references. Report fixtures now preserve their intended old timestamps rather
than silently receiving a fresh Mongoose update time. The broad integration audit
uses complete service request IDs and persisted reusable referral invitations.
Assertions, authorization checks and indexes remain enabled. The concurrency
audit compares an explicit isolated URI against the actual application URI;
it no longer incorrectly compares the isolated URI with itself.

Reusable cloud helpers use isolated loopback MongoDB replica-set databases,
strong process-local test keys, development mail/SMS sinks and system Chromium.
Run one database group at a time from `/workspace/classic-mart`:

```sh
node .classic-mart/finance-workspace-checks.mjs new
node .classic-mart/finance-workspace-checks.mjs regression
node .classic-mart/finance-workspace-checks.mjs contracts
node .classic-mart/finance-audit-checks.mjs integration
node .classic-mart/finance-audit-checks.mjs concurrency
```

Preserve exit status and actual executed/pass/fail/skipped counts in
`/tmp/classicmart-finance-*.log`. Await model index initialization before database
teardown. Current checks do not verify live Gmail, eSMS Africa or Pesapal delivery
and settlement. The approved palette retains the documented strict contrast
limitation in [public accessibility](../public-accessibility.md). These changes
do not claim a passing broad release suite, full WCAG compliance, production
load certification or absolute security.
