# Authoritative State Machines

Routes and application services must request these transitions; they must not directly invent status values.

## Online order payment (Pesapal)

```text
unpaid
  -> payment intent created
pending_provider
  -> Pesapal SubmitOrderRequest
customer_at_pesapal
  -> callback/IPN is received (notification only)
verifying
  -> GetTransactionStatus
  -> COMPLETED + amount/currency/reference match
paid
  -> local payment/inventory/ledger transaction commits
```

Failure branches include retryable provider failure, expired attempt and integrity mismatch. A new attempt is allowed only after the previous live payable obligation is no longer active.

## Cancellation

Unpaid cancellation may expire/release inventory directly according to policy. Paid cancellation follows:

```text
eligible paid order
 -> transaction: freeze fulfilment + cancel local pending work + restore releasable stock
 -> cancellation_refund_pending
 -> submit/refconcile refund
 -> cancelled/refunded
```

If provider refund outcome is uncertain, the order remains non-fulfillable and Finance reconciliation is required. It is never reopened merely because an external call failed.

## Refund

```text
requested
 -> atomically reserve remaining refundable value
provider_pending OR external_manual_pending
 -> verified provider/manual outcome
completed
 -> transaction: ledger reversal + exact line refunded counters + immutable credit note
```

A failed/rejected refund releases only its unconsumed reservation. Provider limitations are represented explicitly rather than fabricated.

## Return

```text
verified delivered order line
 -> requested (quantity atomically reserved)
 -> approved | rejected
rejected -> reservation released
approved -> unique return shipment
 -> returned/received
 -> inspected
 -> refund_or_exchange decision
 -> refunded/exchanged/closed
```

`not received` is a delivery dispute, not a goods return.

## Outbound shipment

```text
created -> offered/assigned -> pickup proof -> picked_up -> in_transit
 -> delivery proof -> delivered
```

Verified delivery updates shipment/parcel/SellerOrder/root Order/delivery earning in one transaction. Delivery OTPs are attempt-limited, HMAC verified and single-use.

## Return shipment

```text
created -> pickup/transport -> returned_to_seller_or_warehouse
```

A return delivery updates return logistics/receipt only. It must not execute outbound customer fulfilment or COD collection logic.

## Payout

```text
requested (liability reserved)
 -> approved by first authorized Finance operator
 -> submitting/external_pending
 -> paid | failed | unknown
```

`unknown` means Classic Mart cannot prove whether the external disbursement happened. **Do not resend.** Reconcile the stable external reference with a separate authorized operator first.

## Chargeback

```text
provider reversal verified
 -> chargeback opened exactly once
 -> ledger reversal posted
 -> finance review
 -> won | lost
won -> recovery ledger transaction
lost -> reversal remains final
```

Original payment/ledger history remains immutable.

## B2B procurement

```text
procurement request (exact variant/SKU)
 -> approval as required by organization budget policy
 -> RFQ/quote
 -> seller line quotation
 -> buyer accepts quote
 -> immutable PO
 -> seller accepts
```

Seller acceptance creates actual commerce, not a fake fulfilled flag.

### Immediate payment terms

```text
PO accepted
 -> stock reserved
 -> Order + SellerOrder + BusinessInvoice(payment_pending)
 -> Pesapal
 -> verified payment
 -> stock committed + invoice/order paid
 -> outbound shipment
 -> verified delivery
 -> fulfilled
```

If payment reservation expires: release stock, expire Order, void invoice, expire PO and make the procurement quantity available for a new quote.

### Approved credit terms

```text
PO accepted
 -> stock committed
 -> Order + SellerOrder + BusinessInvoice(credit_pending_delivery)
 -> shipment
 -> verified delivery
 -> AR recognized + invoice open/due
 -> due | overdue
 -> Pesapal payment
 -> provider clearing clears AR
 -> invoice paid
```

Payment after credit delivery must not replay inventory or seller settlement.

## Support ticket

```text
unassigned -> atomically claimed -> in_progress
 -> waiting_customer | escalated | resolved
```

Only the assignee or an authorized supervisor may mutate/release a claimed ticket.

## Privileged staff access

```text
verified user + MFA
 -> access request
 -> different authorized approver
 -> role + operational-country grants applied
 -> tokenVersion increment / existing sessions revoked
```

Country Admin cannot manufacture Finance, Country Admin or Super Admin authority.

## Privacy request

```text
password step-up
 -> submitted
 -> processing / admin review
 -> export_ready | completed | denied/legal_hold
```

Export files expire after 24 hours. Deletion first checks active orders, financial/legal retention and organizational obligations; permitted deletion anonymizes transactionally and revokes sessions.

## Worker jobs

```text
pending
 -> atomic lease: processing + lockedBy + lockedUntil
 -> success
OR
 -> retryable failure + backoff
 -> pending again
OR
 -> dead_letter after retry policy
```

An expired lease is reclaimable. Unique run/inbox keys prevent duplicate authoritative work.
