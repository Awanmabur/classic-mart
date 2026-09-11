# Classic Mart Production Launch Setup

This production package contains no development database bootstrap, reset tooling, demo marketplace records, stock-photo downloader, seed-product assets, unused dashboard mock assets, test suites or CI fixtures. Its staged `package.json` also removes `devDependencies`, and the Docker image installs runtime dependencies only.

## Required real services

1. Transaction-capable managed MongoDB replica set/mongos.
2. Managed Redis reachable through `REDIS_URL`.
3. HTTPS public domain in `BASE_URL`.
4. Live Pesapal API 3.0 merchant key/secret with `PESAPAL_SANDBOX=false`. The first HTTPS deploy may start without `PESAPAL_IPN_ID`; checkout remains fail-closed until you register `BASE_URL/webhooks/pesapal`, store the returned IPN ID, and redeploy.
5. SMTP credentials for transactional email.
6. Twilio credentials for phone verification, unless another SMS adapter is implemented before launch.
7. ClamAV scanning for untrusted uploads. The production Docker image includes `clamscan` and refreshes virus definitions during image build, so the default Render launch does not require a separate ClamAV service.
8. Private Cloudflare R2 bucket for marketplace media. Production requires `MEDIA_STORAGE_DRIVER=r2`, the Cloudflare S3 endpoint, bucket name, Access Key ID and Secret Access Key. Keep the bucket private; do not enable `r2.dev` or public access for this launch because KYC/evidence shares the storage boundary.
9. Durable mounted filesystem at `PERSISTENT_STORAGE_ROOT` for temporary exports/privacy files only. Marketplace uploads are stored in R2. On Render, mount `/var/data` and use `/var/data/classic-mart` as the root for those temporary operational files.
10. SIEM endpoint/collector and the Stage 12 launch-evidence controls required by `npm run launch:check`.


## Render same-day deployment

The repository now includes `render.yaml`. Create/sync a Render Blueprint from the repository and provide every value marked as a secret prompt. The Blueprint pins the web service to Render `1c-2g` (1 CPU / 2 GB RAM), uses the Dockerfile, one service instance, `/health/ready`, a persistent disk mounted at `/var/data`, and runs migration + production bootstrap + development-data rejection before each deploy. Render persistent disks require a paid web-service plan.

Render does not mount a service disk during `preDeployCommand`. Classic Mart therefore keeps pre-deploy work database-only; the running web and worker processes verify `/var/data/classic-mart` is writable after the disk is mounted at runtime.

The first deploy requires `ADMIN_PASSWORD`. It does not require `PESAPAL_IPN_ID`, which is intentionally configured after the public HTTPS endpoint exists. After confirming Super Admin login, remove only `ADMIN_PASSWORD` from the Render environment; future deploys can rerun the bootstrap safely because the existing administrator is detected.

Do not upload the local `storage`, `.classic-mart`, `.env`, test data, or the development seed media to Render. The production artifact excludes them.

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

Never commit the Access Key ID/Secret to Git. After adding the values to Render, verify the integration from the Render Shell:

```bash
NODE_ENV=production npm run media:r2:check
```

Expected success:

```text
Cloudflare R2 media storage is ready.
```

The check writes a short random probe object, reads it back, verifies its checksum and deletes it. Startup and `launch:check` perform the same fail-closed R2 readiness validation.

Uploaded marketplace media now goes to R2. The Render disk is not used for product/KYC/evidence images in production; it remains only for temporary export/privacy artifacts. The v2.13.49 development path is also R2-first when using `.env.example`; the initial catalogue import uploads its processed product images directly to the configured private R2 bucket.

## First production bootstrap

Copy `.env.production.example` values into the deployment secret/environment manager and replace every placeholder. Keep `ADMIN_PASSWORD` only for the one-time bootstrap.

```bash
NODE_ENV=production npm run bootstrap:production
```

This creates only: selected launch-country settings, the canonical marketplace taxonomy, the initial Super Admin identity/grant, and required indexes. It creates no seller, product, order, promoter, review, campaign, warehouse, stock or transaction demo data.

After verifying Super Admin login, remove `ADMIN_PASSWORD` from runtime environment and redeploy.

## Payment setup

Register the live Pesapal IPN after the first public HTTPS deploy is reachable:

```bash
NODE_ENV=production npm run pesapal:register-ipn
```

Store the returned notification/IPN ID as `PESAPAL_IPN_ID` in Render, redeploy, then complete a real low-value payment certification and verify callback/IPN/provider-status reconciliation. Until the ID is configured, the storefront can run but Pesapal order submission returns a controlled configuration error instead of sending an invalid payment request.

## Database migration and launch gates

```bash
NODE_ENV=production npm run migrate:plan
NODE_ENV=production npm run migrate:apply
NODE_ENV=production npm run launch:check
```

Do not bypass a failed launch gate. Resolve the reported evidence/provider/security issue first.
