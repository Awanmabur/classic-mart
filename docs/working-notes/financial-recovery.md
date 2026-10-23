# Financial recovery handoff

Rebuilding from ae09365 (v2.13.74); lost uncommitted work is not treated as verified.

Owned services: funded customer rewards and Club, per-market loyalty, immutable
purchase/referral reversals, payment/refund/chargeback conservation, Finance
exception drilldown. Approved UI and CSS remain unchanged.

Integration contracts being restored:
- `customerRewardSummary({ userId, country, currency, setting, session })` and
  `redeemCustomerReward({ user, country, currency, rewardKey, idempotencyKey, setting }, session)`.
- `quoteCheckoutBenefits`, `reserveOrderReward`, `consumeOrderReward`,
  `releaseOrderReward`, immutable Order funding/loyalty snapshots.
- Money helpers accept immutable per-line platform contributions; customer cash
  plus platform expense equals original seller/fee/gross shipping/tax credits.
- Refund slices reverse original cash, subsidy, fee and seller contributions;
  full refunds invert every original entry. Shipping rewards restore only after
  the complete original settlement is reversed.
- Loyalty debt blocks new benefits and is repaid by future actual earnings.
  Refund/final independently verified chargeback reversals retain original entry
  lineage; referral qualification cannot be repeated after a full reversal.
- Create and verify compound user/country unique index before retiring the old
  global user unique constraint. Invalid/duplicate preflight fails unchanged.

## Recovery completed in source on 23 October

The restored code includes market-scoped reward issuance, Club quotes and
immutable checkout funding/earning snapshots. An issued reward is reserved with
its order and consumed only with verified payment/COD reconciliation. Expiry or
unpaid cancellation can release a reservation. Full refunds restore a consumed
reward only when original accounting plus actual completed refund postings has
zero remaining exposure, including shipping and funding.

`money.js` checks every new funded order against its exact SellerOrder line
quantities, prices, cash, subsidy, fee and seller snapshots. Wallet/Pesapal debit
only customer cash; `platform_rewards_expense` supplies the discount subsidy.
Partial refunds freeze the original line hash and cash offset, recover the exact
rounding slice, and serialize pending funded-line refunds. An untouched full
refund inverts the original ledger credits and expense funding rather than
reconstructing current prices.

`loyalty.js` retains original earning entries and actual refund/chargeback
lineage. Reversal debt pauses redemption, Club discounts and trial multipliers;
an ordinary cash purchase remains possible and earns base points to recover
debt. Referral recovery validates the original buyer/referrer ownership and runs
even if purchase earning is absent or current programme settings changed.

Wallet debit now revalidates the actual request's current User/token/Device in
the payment transaction and uses the exact active Order market wallet, allowing
shopping outside the home market without conversion or another account's funds.
Seller payout access and writes use accepted membership/current owner/device
and market fences. Delivery payout access and writes call approved current
`deliveryAccess` in the reservation transaction; Finance remains independently
responsible for destination review and settlement proof.

`scripts/migrate-production.js` includes a bounded read-only loyalty preflight.
Invalid/duplicate accounts stop apply before other data/index mutations. Apply
creates and reads back the compound user/country constraint before dropping the
legacy global user constraint. It copies no balances. A failed drop is safe to
retry with both constraints retained.

Finance exception summary and drilldown share `financeExceptionSources` for
provider events, stale refunds, unknown payouts, disputes, reconciliation runs
and pending COD. The reports preserve country/currency groups, actual record
destinations, keyset pages and complete scoped CSV with access rechecks.

## Root integration

- `models/index.js` already exports `CustomerReward`; loyalty models use the
  compound index. No new reward background worker is required.
- Checkout must persist `fundingSnapshot` / `loyaltySnapshot` and each seller
  line's `platformContributionMinor`, call `reserveOrderReward` in the same order
  transaction, and call `releaseOrderReward` only after unpaid expiry/cancellation.
- Approved market configuration must explicitly author/review
  `growth.rewardCatalogue` and `growth.clubBenefits`; neither has invented money
  benefits. Super Admin agent owns that review UI/parser.
- Delivery logistics already calls `orderFundingLedgerEntries` and
  `consumeOrderReward` for verified COD; Delivery agent owns final receipt and
  source authorization checks.

## Validation status

This agent has run only `git diff --check`; no Node, database, HTTP, browser,
provider, worker or commit job was run here. Root owns serialized execution.

Focused test files for root:

- `test/reward-funding.test.js`: exhaustive minor-unit rounding slices, per-unit
  cash floor and rejection of altered/duplicated/cross-market snapshots.
- `test/reward-funding-live.test.js`: actual wallet payment and stock commit,
  funded seller/expense ledger, complete and sequential partial refunds, private
  financial documents, reward and original earning reversal, selected-market
  wallet, revoked Device/invalid funding rollback, and debt behavior.
- `test/loyalty-recovery-live.test.js`: original immutable earning/referral
  recovery, partial refund then independently resolved loss, debt repayment,
  invalid chargeback proof, rollback and concurrent replay.
- `test/loyalty-market-migration-live.test.js`: no balance copying, replacement
  uniqueness before retirement, failed-drop recovery and invalid preflight.

The first root run exposed missing unique cart/order fixture keys in the
loyalty test; those fixtures now use distinct source identities and keys. Root
must rerun before claiming passing evidence. Current provider delivery and
production deployment remain separate checks requiring configured secrets.
