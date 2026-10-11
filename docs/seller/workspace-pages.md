# Connected Seller workspace

The approved reference is `dashboard-preview/final19/role-workspaces.js` and its
original stylesheets. The live workspace preserves its headings, four metric
cards, table controls, 292px desktop side column, health panel and workflows.
Store settings retain their five settings sections. Live actions and accessible
links use Seller-scoped additions; the approved base assets remain unchanged.

## Canonical routes and persisted operations

| Page | Route | Data and operations |
| --- | --- | --- |
| Overview | `/seller/overview` | Paid sales, refunds, orders, catalogue, reviews, team and CSV |
| Products | `/seller/products` | Scoped catalogue, filters, publication and real CSV export |
| Add Product | `/seller/products/new` | Validated product, variants and save-before-media workflow |
| Inventory | `/seller/inventory` | Warehouses, receipts, reductions, stock conditions, lots and movement history |
| Orders | `/seller/orders` | Store order items, fulfilment transitions and order details |
| Shipping | `/seller/shipping` | Shipment readiness, assigned courier and fulfilment records |
| Returns | `/seller/returns` | Refund cases, seller responses and private evidence uploads |
| Customers | `/seller/customers` | Buyers from store orders, scoped order summaries and queued contact |
| Promotions | `/seller/promotions` | Store promotions, product eligibility and versioned activation |
| Coupons | `/seller/coupons` | Validated coupon creation, activation and checkout application |
| Earnings | `/seller/earnings` | Own ledger entries, actual payable balance and contribution reports |
| Payouts | `/seller/payouts` | Masked destinations, destination requests, reserved payouts and status |
| Analytics | `/seller/analytics` | Store sales and refunds by reporting period and CSV |
| Reviews | `/seller/reviews` | Store product reviews and review disputes |
| Messages | `/seller/messages` | Store conversations, replies, resolution and product question answers |
| Store | `/seller/store` | Profile, business, payout destination, communication and security settings |
| Subscription | `/seller/subscription` | Real plans, subscription history and approval requests |

Owner navigation contains all 17 links. Staff navigation exposes only operations
authorized by current store membership. Legacy `/dashboard/seller-*` page links
redirect with HTTP 308 and retain filters. Personal account security keeps the
Seller shell and returns to an authorized Seller page after MFA enrollment.

## Data and write boundaries

Services recheck current identity, session version, membership and store scope
before mutations. Routes also enforce verified identity, onboarding, configured
MFA and CSRF. Store, country and currency constrain queries where applicable.
Private pages are served with `no-store` and `noindex, nofollow, noarchive`.
DTOs omit encryption material, other-store ledger entries and other-store
customer records. CSV exports neutralize spreadsheet formulas.

Stock changes and warehouse archival share transactional location guards.
Version checks prevent stale condition and lot writes, including inputs that
would otherwise be no-ops. Inactive variants with physical stock remain visible
for clearance; positive receipts require an active variant. Lots cannot allocate
more than the available physical stock. Open tasks and nonempty stock block
warehouse archival.

Payout requests reserve real store funds and use the existing approval and
processing lifecycle. A store finance member's separate Promoter identity does
not select Promoter funds for a Seller payout. Payout destination details remain
encrypted and the workspace shows masked details. Subscription requests do not
activate paid plans before independent approval and payment. Contact queues use
existing handled notification events; replies persist before notification.

Empty records are shown explicitly. No preview customers, transactions,
conversion rates, traffic statistics or external payment success are invented.
User-facing dates use the store time zone; the Uganda fixture uses
`Africa/Kampala`.

## Verification

The new live suites cover all canonical navigation URLs and aliases, actual
desktop/mobile login and layout, store isolation, revoked membership, stale
sessions, configured MFA, CSRF, persistence, stock races, coupon checkout,
customer aggregation, support responses and store payout scope. They use
isolated MongoDB replica-set databases, await model indexes and run serially.
Existing Seller login, MFA, account, catalogue, orders, store, overview and
warehouse suites provide regression coverage.

### Results on 2026-10-12 (Africa/Kampala)

| Check | Result |
| --- | --- |
| Five new Seller live suites, including all 17 destinations at 1366px and 390px | 44 passed; no failures, cancellations or skips |
| Existing approved assets, role landing, account shell, MFA, products, orders, store and overview checks | 39 passed |
| Warehouse integrity after correcting the local database resource limit | 8 passed; no failures, cancellations or skips |
| Final mobile record readability, authenticated navigation and warehouse rerun | 14 passed; a subset of the checks above |
| Existing payout, finance lifecycle and privileged MFA contracts | 18 passed; no failures, cancellations or skips |
| Project/import, static security, frontend and functionality gates | Passed |

An earlier combined regression attempt reported 39 passes and one database
initialization failure before Warehouse subtests began. MongoDB/WiredTiger
reported "Too many open files", panicked during an index build and restarted.
The isolated verification container had a 16,384 file descriptor limit. It was
recreated with a 65,536 limit and serialized index builds, preserving both data
volumes and the stopped original container. The final 14-check rerun passed
with zero container restarts. No indexes or security assertions were disabled.
Reusable cloud startup instructions include the resource settings.

Provider delivery and settlement are separate verification requirements. These
checks use development mail/SMS sinks and make no live Gmail, eSMS or Pesapal
calls. The original approved palette still has the documented strict contrast
failure in [public accessibility](../public-accessibility.md); these additions
do not claim full WCAG compliance or a passing broad release suite.
