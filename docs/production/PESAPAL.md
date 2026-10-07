# Pesapal API 3.0 Integration

## What Pesapal does in Classic Mart
Pesapal is the online checkout/refund provider. It is **not represented as a seller/promoter/delivery marketplace payout API**. Marketplace payouts use Classic Mart's internal payable ledger plus a four-eyes external disbursement reconciliation workflow.

## Environment
Required in production:
- `PESAPAL_CONSUMER_KEY`
- `PESAPAL_CONSUMER_SECRET`
- `PESAPAL_IPN_ID`
- `PESAPAL_BASE_URL=https://pay.pesapal.com/v3`
- `PESAPAL_SANDBOX=false`
- HTTPS `BASE_URL`

Register IPN after deployment:
```bash
npm run pesapal:register-ipn
```
Copy the returned notification/IPN ID into `PESAPAL_IPN_ID` and restart web/worker processes.

## Payment sequence
```text
Checkout validates cart + stock
  -> Order + inventory reservation
  -> PaymentIntent with unique activeKey/idempotency key
  -> Pesapal authentication token
  -> SubmitOrderRequest
  -> customer redirected to Pesapal
  -> callback/IPN received
  -> durable ProviderEvent stored/deduplicated
  -> worker/server calls GetTransactionStatus
  -> verify COMPLETED + amount + currency + merchant reference
  -> Mongo transaction commits order payment, inventory and ledger
  -> immutable payment receipt
  -> outbox notifications
```

## Security rules
- Never accept status supplied by the browser, callback query or IPN body as proof of payment.
- Match amount, currency and merchant reference to the local intent.
- Provider tracking/reference identifiers are unique/idempotent.
- Provider event payloads are encrypted at rest where stored and are processed through a durable inbox.
- Failed events back off and eventually enter dead-letter state; Admin Health exposes them.

## Refunds
Classic Mart atomically reserves refundable value before contacting a provider. Pesapal refund support is constrained by provider rules; unsupported additional/partial cases use an explicit `external_manual` workflow and a different finance operator must confirm the external reference. Refund completion posts the ledger reversal, updates exact order-line refunded counters and issues an immutable credit note in one transaction.

## Chargebacks/reversals
A verified Pesapal reversal opens one idempotent Chargeback and posts the exact ledger reversal. Finance reviews the case. A won case posts a recovery transaction; a lost case leaves the reversal applied. The provider reversal path must not swallow accounting failure—the provider event retries until accounting is durable.

## B2B
Immediate B2B invoices use Pesapal before fulfilment is released. Approved credit invoices recognize accounts receivable at verified delivery and later Pesapal payment clears that receivable.

## Reconciliation
Admin/Finance must monitor:
- pending/dead Pesapal inbox events;
- verified payments missing ledger transactions;
- successful payments whose order state disagrees;
- refunds missing ledger/credit-note records;
- chargebacks missing reversal/recovery entries.
These are automatically surfaced by the invariant monitor.
