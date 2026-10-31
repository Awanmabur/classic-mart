# Classic Mart Production Launch Setup

Start with the [launch handoff](docs/production/LAUNCH.md) for the complete
configuration, migration, administrator, provider and deployment checklist.

Read [staged launch operations](docs/production/staged-launch.md) for released
registration types, staff provisioning, MFA-protected launch evidence, current
worker readiness, logging and verification limits. Use the actual HTTPS domain
and launch markets; example values do not establish production readiness.

This production package contains no development database bootstrap, reset tooling, demo marketplace records, stock-photo downloader, seed-product assets, unused dashboard mock assets, test suites or CI fixtures. Its staged `package.json` also removes `devDependencies`, and the Docker image installs runtime dependencies only.

## Required real services

1. Transaction-capable managed MongoDB replica set/mongos.
2. Managed Redis reachable through `REDIS_URL`.
3. HTTPS public domain in `BASE_URL`.
4. Live Pesapal API 3.0 merchant key/secret with `PESAPAL_SANDBOX=false`. The first HTTPS deploy may start without `PESAPAL_IPN_ID`; checkout remains fail-closed until you register `BASE_URL/webhooks/pesapal`, store the returned IPN ID, and redeploy.
5. SMTP credentials for transactional email.
6. Yoola SMS credentials and an approved sender for phone verification.
7. ClamAV scanning for untrusted uploads. The production Docker image includes `clamscan` and fetches signed definitions during image build. Keep definitions current through frequent rebuilds or a managed, continuously updated private `clamd` service; build-time freshness does not last indefinitely. Uploads reject stale definitions. See the scanner freshness requirements in the operating guide.
8. Private Cloudflare R2 bucket for marketplace media. Production requires `MEDIA_STORAGE_DRIVER=r2`, the Cloudflare S3 endpoint, bucket name, Access Key ID and Secret Access Key. Keep the bucket private; do not enable `r2.dev` or public access for this launch because KYC/evidence shares the storage boundary.
9. Durable mounted filesystem at `PERSISTENT_STORAGE_ROOT` for temporary exports/privacy files only. Marketplace uploads are stored in R2. Mount a persistent host path into the container; never rely on the container's ephemeral writable layer for operational files.
10. SIEM endpoint/collector and the Stage 12 launch-evidence controls required by `node scripts/launch-check.js`.


## DigitalOcean / Docker deployment

Classic Mart production is deployed as an immutable Docker image identified by the full reviewed Git SHA. Runtime secrets and infrastructure configuration stay outside the repository. The production host supplies the environment, persistent storage and reverse-proxy configuration; the repository does not contain a provider-specific deployment blueprint.

Build from the exact certified commit and keep the image tag equal to that commit SHA. Use a no-cache production rebuild when refreshing ClamAV definitions:

```bash
docker build --pull --no-cache --build-arg BUILD_SHA="$BUILD_SHA" -t "classic-mart:$BUILD_SHA" .
```

The final Docker image contains the Node runtime and installed application dependencies. It excludes npm and npx; dependency installation runs in a separate build stage. Source checkouts and extracted archives can still use their `package.json` command aliases after installing the committed lockfile.

The first deploy requires `ADMIN_PASSWORD` only when the trusted administrator does not already exist. After confirming Super Admin login, remove `ADMIN_PASSWORD` from the production secret environment. The application may start before `PESAPAL_IPN_ID` is registered, but checkout remains fail-closed until the live IPN is configured.

Do not copy local `storage`, `.classic-mart`, `.env`, development seed media, test data or preview assets into production.

Builds behind a trusted TLS-inspection proxy can supply its verified CA through BuildKit without embedding it in the image. Never disable certificate or package-integrity checks.

Scanner definition refreshes must bypass the cached definition layer. CI uses `--no-cache`; production refresh builds should do the same. Schedule refreshes before the scanner age limit or use a continuously updated private `clamd` service.

## Cloudflare R2 media storage

Create one private R2 bucket, recommended name `classic-mart-media`. Create an R2 S3 API token with Object Read & Write permission scoped only to that bucket. Do not enable the Public Development URL and do not configure a public custom domain for this private bucket.

Set these production variables:

```env
MEDIA_STORAGE_DRIVER=r2
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_BUCKET=classic-mart-media
R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_REGION=auto
R2_TIMEOUT_MS=10000
```

Never commit the Access Key ID/Secret to Git. After adding the values to the production secret environment, verify the integration from the running container or a controlled production shell:

```bash
NODE_ENV=production node scripts/check-r2.js
```

Expected success:

```text
Cloudflare R2 media storage is ready.
```

The check writes a short random probe object, reads it back, verifies its checksum and deletes it. Startup and `launch:check` perform the same fail-closed R2 readiness validation.

`R2_TIMEOUT_MS` covers each complete request, including its response body, and
is bounded to 3,000–60,000 ms. A successful check establishes readiness at that
moment; a later startup request can still encounter a network timeout. The
private readiness probe retries transient timeouts, connection resets and
temporary provider errors up to three times per operation, using the same key
and bytes. Permission, missing-object and checksum errors fail immediately.
Deletion must succeed before the probe reports ready. Application uploads are
not automatically replayed. Permanent failure reports a sanitized storage error
and startup exits nonzero after cleanup; stopping startup cancels the probe and
prevents the HTTP listener or worker from starting afterwards.

Uploaded marketplace media now goes to R2. The mounted production filesystem is not used for product/KYC/evidence images; it remains only for temporary export/privacy artifacts. The v2.13.51 development path is also R2-first when using `.env.example`; the initial catalogue import uploads its processed product images directly to the configured private R2 bucket.

## First production bootstrap

Copy `.env.production.example` values into the deployment secret/environment manager and replace every placeholder. Keep `ADMIN_PASSWORD` only for the one-time bootstrap.

```bash
NODE_ENV=production node scripts/bootstrap-production.js
```

This creates only: selected launch-country settings, the canonical marketplace taxonomy, the initial Super Admin identity/grant, and required indexes. It creates no seller, product, order, promoter, review, campaign, warehouse, stock or transaction demo data.

After verifying Super Admin login, remove `ADMIN_PASSWORD` from runtime environment and redeploy.

## Payment setup

Register the live Pesapal IPN after the first public HTTPS deploy is reachable:

```bash
NODE_ENV=production node scripts/pesapal-register-ipn.js
```

Store the returned notification/IPN ID as `PESAPAL_IPN_ID` in the production secret environment, redeploy, then complete a controlled live payment certification and verify callback/IPN/provider-status reconciliation. Until the ID is configured, the storefront can run but Pesapal order submission returns a controlled configuration error instead of sending an invalid payment request.

## Database migration and launch gates

```bash
NODE_ENV=production node scripts/migrate-production.js
NODE_ENV=production node scripts/migrate-production.js --apply
NODE_ENV=production node scripts/launch-check.js
```

Do not bypass a failed launch gate. Resolve the reported evidence/provider/security issue first.
