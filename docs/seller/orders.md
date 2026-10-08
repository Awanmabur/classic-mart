# Seller orders and shipping

The approved Orders and Shipping pages use the same seller fulfilment service as
the external seller API. Order preparation operates on real checkout, payment,
stock reservations, warehouse tasks, parcels and seller shipments. The original
approved dashboard stylesheets and reference assets remain unchanged.

## Routes and workflow

- `/seller/orders`: current-store orders, search, status tabs and cursor pages.
- `/seller/orders/:publicId`: the store's purchased items, totals, recipient,
  payment, actual reservation warehouses, parcel progress and recorded history.
- `/seller/shipping`: current-store delivery records, with the same status filters.
- `/seller/orders/export.csv`: filtered CSV, limited to 500 matching orders;
  larger exports require narrower filters. Shipping exports exclude awaiting-
  payment records just as the Shipping page does. Spreadsheet formulas are escaped.
- `/api/v1/seller/orders`: scoped, sanitized integration reads.
- `/api/v1/seller/orders/:id/:action`: the same processing, pick, pack and dispatch
  operations, with a current revision and an idempotency key.

Authenticated `/dashboard/seller-orders` and `/dashboard/seller-shipping` links
permanently redirect to the canonical routes, preserving query parameters.
The sidebar enables completed pages according to the current store membership.
Other operational dashboards still require their own approved UI integrations.

Awaiting-payment orders are visible but cannot be prepared. Confirmed COD,
verified paid orders, approved credit orders and exchange replacements can enter
preparation when their inventory reservations are committed. Processing, picking,
packing and dispatch each have a valid predecessor state. Picking records exact
quantities from every reserved warehouse without reducing stock a second time.
Multiple reservation warehouses require an explicit packing location; dispatch
must use that recorded location.

Seller dispatch means **ready for carrier pickup**. Carrier pickup changes the
seller parcel and buyer tracking to shipped. Delivery requires the assigned,
approved delivery partner's proof code and any required photo/signature evidence.
Sellers cannot declare an order delivered. Wrong proof attempts persist and lock
verification after repeated failures. Cancellation updates the root shipment,
parcels and seller shipments consistently.

## Integrity and privacy

Authentication, verified email, onboarding and production privileged MFA protect
web access, including delegated fulfilment staff with customer account roles.
Forms require CSRF and an expected order revision. Mutations and
exports have rate limits. Private pages and downloads use no-store caching and
noindex headers. No frontend role selector is introduced.

The service rechecks the account, token version, current membership, fulfilment
capability, store status, country, currency, payment and cancellation within the
transaction. Authorization and order revision writes fence concurrent changes.
Warehouse tasks, parcel and seller shipment updates, order lifecycle, mandatory
audits and integration delivery records commit together. A failed audit rolls
back the action. Stale forms require reloading instead of overwriting another
operator's work.

Seller projections exclude other stores' line items and totals, internal cost
snapshots, settlement internals, provider references and delivery proof codes.
Delivery contact is restricted to order details for authorized fulfilment staff.
CSV export uses the same scoped projection. API replay rechecks current access.
Delivery offers use current platform grants for country and warehouse access,
including staff authorized in multiple countries. Transaction writes fence grant
revocation and account suspension; stale account-role mirrors cannot restore access.

Payment authorization and shipment creation share a transaction. Eligible legacy
payment retries can restore missing shipment links without consuming stock or
posting money twice. A rolled-back COD or wallet authorization can resume using
the original payment key. Cancellation determines whether a refund is required from
the fresh transaction state. Exchange replacements have actual committed stock
reservations, fresh line identifiers and cleared delivery/return/refund counters;
their shipment is created in the replacement transaction.

## Verification

The focused live tests require an isolated loopback MongoDB replica set and system
Chromium. They create random databases and remove only their own fixtures:

```sh
CLASSIC_MART_LIVE_TEST_MONGO_URI='mongodb://127.0.0.1:27019/classicmart_verification_test?replicaSet=classicmarttest' \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node --test test/seller-orders-live.test.js test/fulfilment-integrity-live.test.js test/order-payment-api-live.test.js
```

Verified on 2026-10-08: **397 canonical tests passed, zero failures and zero
skips**. This includes actual desktop and phone seller forms, a concurrent stale
form returning HTML 409, delegated staff MFA, payment rollback/replay, mandatory
audit rollback, six competing fulfilment writes, actual reservation warehouses,
shipping exports, unclipped desktop/mobile tables, current multi-country grants,
concurrent grant revocation and proof-controlled delivery. The broader public browser suite
passed **50 cases**, with four deliberate opposite-screen-project skips and zero
failures. Project/import, security, frontend and functionality checks, MongoDB
replica-set verification, the stages 1–12 integration audit, 20-way concurrency
audit and migration dry run passed. Dependency audit: zero vulnerabilities.

Order pages default to 25 rows and the API supports up to 100 rows. Default
navigation applies an indexed cursor before loading bounded order context;
status-filtered counts share an aggregation instead of repeating the shipment
join three times. Summaries still aggregate the current store's history. These
checks verify bounded queries and correct behavior, not production-scale latency.

Local payment tests
use real COD and wallet flows; no Pesapal provider responses are fabricated.
Historical exchange orders with synthetic reservation references require an
explicit migration using their recorded inventory movements; the service does
not invent missing warehouse evidence.

Development notification delivery uses the mail sink and does not establish
Gmail or eSMS delivery. Carrier backend proof checks do not certify an unfinished
delivery or warehouse dashboard. This milestone does not certify the entire
marketplace or its production infrastructure.
