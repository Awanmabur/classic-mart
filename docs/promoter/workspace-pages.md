# Connected Promoter workspace

The reference is `dashboard-preview/final19`. Its base stylesheets, scripts and
images remain unchanged. Live pages retain the approved headings, four metrics,
table controls, 292px desktop side column and workflow panels. Traffic and
Analytics retain their chart layout, with actual records below it. Profile
retains five settings sections. Mobile records wrap long identifiers and forms.

| Page | Canonical route | Persisted data and operations |
| --- | --- | --- |
| Overview | `/promoter/overview` | Eligible visits, verified paid orders, actual funds, accepted campaigns, reporting periods and CSV |
| Marketplace | `/promoter/marketplace` | Eligible campaign discovery, search and applications |
| Campaigns | `/promoter/campaigns` | Own application history and authorized campaign briefs |
| Links | `/promoter/links` | Campaign-approved local destinations, tracking links, edits and deactivation |
| Content | `/promoter/content` | Saved kits built from approved campaign facts and assets with affiliate disclosures |
| Traffic | `/promoter/traffic` | Recorded eligible and blocked visits, channel summaries and export |
| Conversions | `/promoter/conversions` | Attributed checkouts and separately verified paid orders |
| Commissions | `/promoter/commissions` | Estimates, posted funds, reversals, payment progress and reversal appeals |
| Wallet | `/promoter/wallet` | Own ledger entries, available balance, reserved funds and export |
| Payouts | `/promoter/payouts` | Masked destinations, destination review requests, payout reservations and statuses |
| Analytics | `/promoter/analytics` | Actual period/channel performance and export |
| Referrals | `/promoter/referrals` | Reusable invitation, independent registration receipts and first paid purchase rewards |
| Brands | `/promoter/brands` | Eligible merchants and persisted follows |
| Messages | `/promoter/messages` | Customer requests and two-way accepted-campaign conversations |
| Profile | `/promoter/profile` | Personal fields, channels/audience verification, payment links, communication and personal security |

Legacy `/dashboard/promoter-*` URLs redirect with HTTP 308 and preserve query
parameters. All fifteen navigation entries point to live pages. Private pages
and exports use `no-store` and `noindex, nofollow, noarchive`.

## Access, privacy and accounting

Services reload identity, token version, primary workspace and programme market.
Current verification and an eligible accepted campaign are required for new
earning activity. Programme revocation retains access to a still-active
identity's historical earned funds. Mutations validate input, enforce CSRF and
rate limits, and use transaction guards or version checks where needed.

Public campaign metadata excludes invite-only briefs, private assets and owner
identifiers. Buyer contact details, visitor session/IP hashes, encryption
material and other identities' balances are omitted from page data. CSV exports
neutralize formula cells. Promotional redirects permit approved local product
and marketplace destinations. A server-owned session key binds attribution to
the visitor through signup/login; a copied touch identifier does not suffice.

An attributed checkout remains an estimate until payment. Partial refunds,
repeated refunds, appeal decisions and payout settlement preserve ledger
accounting and market scope. Appeals of unposted estimates cannot create
withdrawable funds. Payouts use actual balances and the existing independent
approval/reconciliation lifecycle; requesting one does not simulate provider
settlement. Content kits explicitly use deterministic approved facts rather
than claiming an external AI response.

Campaign conversations require exactly the accepted Promoter and current
verified Seller owner. Staff and unrelated/general conversations are excluded.
Customer requests use the existing customer reply endpoint. Replies persist
with transactional audit and notifications before successful responses.

## Verification limits

### Results on 2026-10-12 (Africa/Kampala)

| Check | Result |
| --- | --- |
| Six new Promoter suites, including all fifteen destinations at 1366px and 390px | 66 distinct checks passed across the final runs |
| Corrected finance and navigation rerun | 19 passed; no failures, cancellations or skips; included in the 66 above |
| Existing role, Seller signup/MFA/account/navigation, payment API and Customer wallet regression group | 79 passed; 2 failures represent the existing Seller enrolment contrast assertion and its parent test |
| Existing finance, attribution, referral, payout and MFA contracts | 33 passed; no failures, cancellations or skips |
| Project/import, static security, frontend and functionality gates | Passed |
| Verification MongoDB | Writable primary; zero container restarts |

The first full Promoter run completed 66 checks with 61 passes and five reported
failures, including parent tests. Two finance assertions expected whitespace
removed by the Campaign model and HTTP 200 instead of the appeal route's HTTP
201. The welcome indicator also needed smaller status text on mobile. The final
19-check rerun corrected those expectations, verified the visible text fit and
completed both finance and desktop/mobile navigation suites. Earlier fixture
corrections supplied real unique order keys, top-level checkout city and the
authoritative marketplace programme ID. Assertions and indexes remain enabled.

The reusable cloud helper is `.classic-mart/promoter-workspace-checks.mjs`.
From `/workspace/classic-mart`, run `node .classic-mart/promoter-workspace-checks.mjs new`,
`regression` or `contracts`, one group at a time. It uses strong process-local
test keys, isolated loopback MongoDB, development delivery sinks and system
Chromium. Logs preserve actual counts and exit status. The `regression` group
continues to report the existing contrast failure rather than suppressing it.

Focused tests use isolated MongoDB replica-set databases, await model indexes
and run serially. Real Chromium checks cover all fifteen pages at desktop and
mobile sizes. Delivery checks use development mail/SMS sinks and make no real
Gmail, eSMS Africa or Pesapal calls. Production provider delivery and settlement
remain separate requirements. The approved palette retains the documented
strict contrast failure in [public accessibility](../public-accessibility.md);
these changes do not claim full WCAG compliance or a passing broad release suite.
