# Data Model, Ownership and Sources of Truth

This document describes the authoritative domain records. UI status text is never the source of truth; server-owned database records and immutable snapshots are.

## Identity and authorization

### `User`
Stores account identity, verification state, customer-facing `shoppingCountry`, privileged platform role and server-controlled `operationalCountries` grants. `shoppingCountry` is **not** an authorization boundary.

### Memberships
Seller/store and business organization access is membership/capability-based. A person's platform role does not automatically grant access to every store or company.

### `ApprovalRequest`
Authoritative four-eyes record for high-risk administrative operations such as privileged staff access and other protected changes. Requester and approver must satisfy the workflow's separation rules.

## Catalogue and inventory

`Product` + immutable/order-time variant snapshots describe what was sold. Live catalogue edits never rewrite historical order lines.

Warehouse stock is authoritative for on-hand/reserved/damaged/quarantined state. Availability is derived from those counters. Negative or over-reserved stock is an invariant violation, not an acceptable transient UI state.

## Customer commerce

### `Order`
Root customer/business order. Important fields include independent payment/fulfilment dimensions plus immutable order-line snapshots. Every line has `linePublicId` and exact variant/SKU information.

Line quantity accounting follows:

```text
deliveredQuantity
  >= returnReservedQuantity + returnedQuantity
returnedQuantity
  >= refundedQuantity
```

### `SellerOrder`
Per-store fulfilment/settlement projection of an Order. It exists so one multi-seller checkout can be operated by each seller without exposing another store's private fulfilment state.

### `Shipment`
Authoritative logistics state. Outbound and return shipments are distinct state paths. Database uniqueness prevents duplicate outbound shipments for one intended fulfilment and duplicate return shipments for one return case.

## Payments and accounting

### `PaymentIntent`
One historical payment attempt. There may be many historical attempts, but a unique active key prevents more than one live payable obligation for the same payment purpose/order.

### `ProviderEvent`
Durable Pesapal inbox item. It records/deduplicates provider notifications and is lease-processed. Provider payload status is not financial truth; the worker/server obtains authoritative transaction status from Pesapal.

### Ledger
The double-entry ledger is the financial source of truth for seller payable, platform revenue, tax, provider/COD clearing, promoter payable, delivery earnings and B2B receivables. Do not manually mutate posted ledger transactions.

### `Refund`
Controls refund amount reservation, provider/manual status and exact local settlement. A completed refund must have a corresponding ledger reversal and immutable credit note.

### `FinancialDocument`
Immutable payment receipts/credit notes generated from the financial event snapshot. Historical documents are not regenerated from mutable live Order state.

### `Chargeback`
Idempotent Pesapal/provider reversal case linked to exact ledger reversal/recovery. Finance resolution records won/lost outcome without rewriting original financial history.

### `Payout`
Represents internal payable reservation plus externally reconciled disbursement. Pesapal is **not** modeled as a marketplace payout API. Ambiguous external status must be reconciled before any resend.

## Returns and trust

### `ReturnRequest`
References exact `orderLineId` lines, quantities, evidence and return logistics. Quantity is reserved atomically when the request is created.

### `SellerReturnCase`
Store-private response surface for a multi-seller return. It exposes only that store's returned lines and seller-private evidence to the appropriate seller/support operators.

`SupportTicket`, disputes, trust cases, reviews, CSAT and risk records are country/resource scoped according to server-controlled authorization grants.

## B2B

### `BusinessOrganization`
Company identity, billing/delivery contacts, memberships, budgets and approved credit settings.

### `ProcurementRequest`
Buyer requirement for exact product + variant/SKU + quantity.

### `QuoteRequest`
Seller response with exact offered unit price for each immutable requested line.

### `PurchaseOrder`
Immutable accepted commercial terms and exact lines. Acceptance bridges into real commerce; the seller cannot simply mark a PO fulfilled.

### `BusinessInvoice`
Authoritative invoice/payment-term state. Immediate terms use Pesapal before fulfilment is released. Credit terms become receivable at verified delivery and later payment clears that receivable.

### `ProcurementRun`
Unique `templateId + scheduledFor` record that prevents duplicate recurring procurement under concurrent workers.

## Privacy and operations

### `PrivacyRequest`
Data-access/export/correction/deletion/restriction workflow. Exports have short retention; deletion is blocked by legal/commerce obligations and anonymization is transactional.

### `OperationalAlert`
Persisted business-invariant finding. It is not merely a log line. Active defects reopen resolved alerts; explicit suppression is preserved.

### Outboxes / deliveries
Email/push/seller-webhook outboxes use atomic expiring leases. A crash cannot permanently own a `processing` item; another worker may reclaim it after lock expiry.

## Database rule of thumb

Use three layers for critical invariants:

1. **Unique/index/schema constraint** when representable in MongoDB.
2. **Transaction / compare-and-set** for multi-record and quantity/state transitions.
3. **Invariant monitor + concurrency test** to detect regressions that escape the first two layers.
