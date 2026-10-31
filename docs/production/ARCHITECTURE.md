# Classic Mart Production Architecture

## Architecture style
Classic Mart is a **modular monolith**. HTTP traffic and background work are deliberately separated into two processes while sharing the same MongoDB transaction-capable database and Redis infrastructure.

```text
Internet / PWA / mobile client
        |
        v
Reverse proxy / TLS
        |
        v
Classic Mart web process (src/server.js)
        |
        +--> MongoDB replica set / Atlas
        +--> Redis sessions/cache/rate state
        +--> Pesapal API 3.0
        +--> SMTP / SMS / push / seller webhooks

Classic Mart worker (src/worker.js)
        |
        +--> provider-event inbox
        +--> notification / push / webhook outboxes
        +--> recurring procurement
        +--> privacy work
        +--> scheduled pricing / AI jobs
        +--> business invoice aging
        +--> invariant monitoring
```

The web process **does not run the maintenance scheduler**. This avoids duplicate jobs when web replicas scale horizontally.

## Domain modules
- **Identity & authorization:** authentication, verification, MFA, sessions, operational-country grants, seller/business memberships.
- **Catalogue:** products, variants, brands, categories, media moderation.
- **Commerce:** cart, pricing, checkout, orders and immutable order-line snapshots.
- **Inventory:** warehouse stock, reservation, movement and condition counters.
- **Fulfilment:** SellerOrder, parcels, outbound shipments, returns and delivery proof.
- **Money:** Pesapal payment intents, double-entry ledger, refunds, chargebacks, payout holds/reconciliation and immutable financial documents.
- **B2B:** organization membership, budgets, procurement, quotations, POs, BusinessInvoice, immediate payment and credit receivables.
- **Trust:** reviews, returns, disputes, support tickets, risk cases and seller return responses.
- **Operations:** four-eyes approvals, staff access, privacy requests, security events, incidents and operational alerts.

## Transaction rule
Any business decision that mutates several authoritative local records is performed in a MongoDB transaction. External calls are **not** placed inside a transaction. Instead Classic Mart persists durable intent/inbox/outbox state and makes the external operation replayable/idempotent.

## Core invariants
1. One order may have historical payment attempts, but only one live payable attempt.
2. Pesapal IPN/callback data is never proof of payment; server-to-server transaction-status verification is authoritative.
3. Refund completed/reserved value can never exceed the verified captured amount.
4. Return reserved + returned quantity can never exceed delivered quantity; refunded quantity can never exceed returned quantity.
5. A payout liability is reserved once and cannot be sent again while the external outcome is unknown.
6. A shipment state transition is server-authorized, ordered and proof-controlled.
7. A non-global operator may never access a country outside `operationalCountries`.
8. Ledger transactions and financial documents are immutable.
9. Background jobs are lease-claimed and reclaimable after worker failure.
10. B2B credit delivery recognizes receivable; later Pesapal payment clears the receivable rather than replaying fulfilment.

## State dimensions
`Order.status` remains a customer-friendly aggregate state, while authoritative independent dimensions include `paymentState` and `fulfillmentState`. Returns, refunds, shipment state, invoice state and chargeback state are separate domain records to avoid overloading one status field.

## Scaling
Scale web and worker independently. Before increasing worker replicas, retain atomic lease claiming and unique run/inbox invariants. MongoDB must support multi-document transactions (replica set or sharded deployment). Redis is not authoritative commerce storage and can be rebuilt.
