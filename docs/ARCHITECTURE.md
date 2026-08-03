# Architecture

## Decision

Classic Mart uses a modular monolith: Node.js 24, Express 5, EJS and transaction-capable MongoDB. The user-requested MongoDB choice replaces the blueprint's PostgreSQL choice. MongoDB Atlas is recommended for development, but any replica set or mongos is supported. Redis is optional.

## Runtime flow

1. A reverse proxy terminates HTTPS and forwards only trusted headers.
2. Express assigns a request ID, applies security headers and serves versioned
   public assets.
3. State-changing requests pass size limits, HPP protection, session loading,
   CSRF validation, user/device validation and route authorization.
4. Services own business rules. Routes parse input and coordinate services;
   views do not decide trusted state.
5. MongoDB stores authoritative records and append-only audits.
6. When `REDIS_URL` is configured, Redis stores sessions and can support cache/queue coordination. When Redis is absent, MongoDB-backed sessions are used in development or production.

## Current modules

| Module | Responsibility |
|---|---|
| `config` | Validated environment, MongoDB, Redis and structured logging |
| `core` | Errors, IDs/slugs, cryptography, field encryption, roles and permissions |
| `middleware` | Request context, CSRF, sessions, identity, country, seller store and errors |
| `models` | Identity, store/KYC, catalogue, media, inventory, customer discovery state, contacts, outbox and audit |
| `services` | Authentication, email, country, catalogue, storefront, media, inventory, store, outbox and audit |
| `routes` | Health, identity, account, seller, moderation, media, storefront API and public pages |
| `validation` | Zod schemas and field allowlists |
| `views` / `public` | EJS screens and the approved visual baseline |

## Data rules

- Public IDs are random and database `_id` values are not exposed as resource
  identifiers.
- Normalized email/phone values are unique and excluded from normal reads.
- Passwords use Argon2id; verification codes and session identifiers are hashed
  before persistence.
- Active sessions require both a valid server session and a non-revoked device
  record.
- Audit records are append-only at the Mongoose model boundary.
- Seller registration and tax identifiers are encrypted with AES-256-GCM and a
  deployment-owned key; private document storage keys are excluded by default.
- Product/variant/warehouse/stock queries include the owning store ID. Public
  IDs alone never authorize a seller resource.
- Product publication requires a verified store, approved product, active
  variant and approved media.
- Stock enforces `0 ≤ reserved ≤ onHand`; adjustment and reservation workflows
  run in replica-set transactions and write immutable movement history.
- Catalogue/inventory events are written to a transactional outbox and
  immediately invalidate the bounded storefront cache.
- MongoDB indexes support uniqueness and the common country/role/status access
  path.
- Personal and trusted commerce state belongs on the server. Stages 1–8 do not
  use browser storage as authority for identity, cart, wishlist, orders, payment,
  commission, delivery or trust state.

## Performance choices

- Static files use ETags and seven-day production caching.
- EJS template caching is enabled in production.
- Compression starts at 1 KiB.
- Country configuration is cached in process with bounded TTL.
- Storefront catalogue reads use a 20-second bounded cache, coalesce concurrent
  misses and batch related collections without N+1 product queries.
- Public search first applies approved/published/country/sellable filters and
  ranks bounded candidates across title, category, brand, store, tags, SKU and
  barcode with simple typo/synonym recovery; search/click analytics persist.
- Seller lists use bounded queries and compound ownership/status indexes.
- Uploaded media generates a 480px thumbnail and a bounded 2400px normalized
  image; browser pages request the thumbnail where full resolution is wasteful.
- Image transforms use bounded input pixels and never serve raw uploads.
- Device heartbeat writes are limited to once every five minutes.
- Health liveness avoids session/database work; readiness checks dependencies.
- HTTP request/header/keep-alive timeouts and per-socket request bounds reduce
  resource exhaustion risk.

## Scale path

The app remains stateless outside MongoDB/Redis and configured media storage.
Mount `UPLOAD_DIR` on shared durable storage for more than one instance; an
object-storage adapter is the natural production scale replacement. The outbox
is already present for workers, cache invalidation and search indexing. Split a
service only after profiling shows an operational or scaling boundary.

## Stage 5 money boundary
`src/services/payments.js` is the provider orchestration boundary and `src/services/money.js` owns ledger posting. Browser redirects never mutate trusted payment state. Provider success is re-fetched/verified before inventory reservation commitment and ledger posting. Financial history uses append-only ledger transactions; balance is derived from entries. Payout destinations are field-encrypted and excluded from normal reads.


## Stage 1–8 release audit

`npm run release:check` requires a disposable MongoDB integration audit in addition to unit/static checks. The audit runs only against a database whose name ends in `audit-test`, executes the cross-stage commerce path and verifies balanced ledger transactions before Stage 10 is allowed.


### Phone verification hardening (v2.8.2 audit)
Protected account workspaces require both server-verified email and phone. Phone verification codes are single-use server tokens; development may use the log adapter, while production requires the configured Twilio adapter. Changing the phone number clears `phoneVerifiedAt` and requires re-verification.
