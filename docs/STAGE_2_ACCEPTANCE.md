# Stage 2 acceptance record

## Seller verification

- Seller store creation is idempotent and bound to one owner account.
- Individual submissions require a sanitized identity image.
- Business submissions require sanitized identity and registration images.
- Registration and tax identifiers are encrypted before MongoDB persistence.
- Submitted records are locked; rejection records a reason and permits appeal.
- Moderator approval activates the store and records audit/outbox evidence.
- Country admins cannot open or decide a seller outside their country.

## Catalogue and media

- Categories, attributes, brands, products, variants and seed content are
  database records.
- Seller product queries always include the current store ID.
- Draft/change-requested states are editable; review states are locked.
- Publication requires a verified store, approved product, active variant and
  approved media.
- Uploads accept JPEG/PNG/WebP/AVIF only, decode with a pixel limit, reject
  invalid/small images, strip metadata and produce WebP full/thumbnail outputs.
- Raw uploads and filesystem paths are never publicly served.
- Brand requests and category/reference settings have real moderation routes.

## Inventory

- Warehouse resources are store-owned.
- A stock item is unique per warehouse/variant.
- `onHand`, `reserved` and `available` invariants reject negative inventory.
- Adjustments and reservation/release operations run in MongoDB transactions.
- Reservation creation uses an atomic availability predicate and unique
  idempotency key.
- Every stock mutation creates an append-only movement.
- Warehouse archival is blocked while stock remains.

## Bulk and performance

- CSV preview validates all rows before import.
- Import uses one transaction and creates drafts only.
- Invalid rows can be downloaded as an error CSV.
- Seller lists are bounded and indexed; reference reads use lean documents.
- Product pages use generated 480px thumbnails.
- Production EJS caching, static ETags, compression, MongoDB pooling remains enabled; Redis-backed sessions are optional and MongoDB-backed sessions are supported.

## Verification evidence

Run:

```bash
npm ci
npm run db:setup
npm run release:check
```

The release check compiles every source/view, enforces the no-gradient visual
contract, runs the automated test suite plus the cross-stage integration audit and fails on high/critical dependency advisories.
