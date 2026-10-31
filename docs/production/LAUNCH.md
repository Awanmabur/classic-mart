# Launch handoff

Use the reviewed `master` commit, Node.js 24 and the committed lockfile. A merge
or a successful local test run does not sign off a production deployment. Keep
the storefront in a controlled pilot until the checks below pass.

## Configure

Use `.env.production.example` as the settings checklist. Put real values in the
deployment secret manager. The application loads `.env` for local use; merely
creating `.env.production` does not load it. Never commit either populated file.

| Required service or setting | What must be supplied |
| --- | --- |
| Public origin | Real HTTPS `BASE_URL`, actual `TRUST_PROXY` hops, full deployed `BUILD_SHA` |
| MongoDB | Transaction-capable `MONGO_URI` with an explicit database name |
| Redis | Private/TLS `REDIS_URL` with session and atomic rate-limit permissions |
| Application secrets | Independent `SESSION_SECRET`, `TOKEN_PEPPER`, `DATA_ENCRYPTION_KEY`, `SECURITY_INTEGRITY_KEY` |
| Gmail | `MAIL_MODE=smtp`, SMTP identity, Google app password, matching `SMTP_FROM` |
| Yoola | `SMS_MODE=yoola`, account credentials and approved sender from [SMS setup](SMS.md) |
| Pesapal | Live merchant key/secret, live API URL, then registered `PESAPAL_IPN_ID` |
| Media | Private R2 bucket and bucket-scoped read/write credentials |
| Files | Writable mounted `PERSISTENT_STORAGE_ROOT` outside the application tree |
| Upload scanning | Working ClamAV engine and current signed definitions |
| Security operations | SIEM collector, explicit launch countries, recovery objectives and evidence |
| First administrator | Independently verified operator email/phone and temporary bootstrap password |

The first two application secrets need at least 32 random characters each. The
encryption and integrity keys should each be independently generated 32-byte keys
encoded as 64 hexadecimal characters. Do not use example values or share keys.

AI, push and native-app links remain disabled/blank unless their services are
actually configured. Do not enable an unfinished registration type for launch.

## Prepare the database and providers

Take a restorable database backup before migration. From a source checkout or
extracted archive, install the committed dependencies with `npm ci` first. The
Docker image already contains its dependencies and intentionally excludes npm
and npx. In the production environment with its settings already loaded, the
following commands work directly in the container or the installed archive:

```sh
node scripts/migrate-production.js
node scripts/migrate-production.js --apply
node scripts/bootstrap-production.js
node scripts/check-production-data.js
node scripts/check-r2.js
node scripts/verify-mail.js
node scripts/verify-sms.js
```

Review the migration plan before applying it. A blocked reconciliation must be
resolved through current staff-access approval; a stale role label is not an
access grant. Bootstrap creates platform foundations and trusted administrators,
not products or stock. Publish your real catalogue, prices and available stock.

Sign in as each trusted administrator and complete that operator's identity
verification and authenticator setup at `/account/security`. Then remove the
bootstrap passwords from runtime settings. Use two independent administrators
for approval workflows; never share factors or recovery codes. See
[staged launch operations](staged-launch.md) for staff provisioning and evidence.

Provider verification commands have the scope stated in their output; they do
not establish delivery to a real recipient. Complete controlled Gmail and Yoola
delivery checks with an intended recipient before enabling public registration.

## Deploy and open checkout

Deploy the Docker image or the production archive produced by
`npm run release:production`; do not deploy the developer workspace. The Docker
entrypoint runs both web and maintenance worker. From a source checkout use
`NODE_ENV=production npm run start:production`; in the production archive use
`NODE_ENV=production npm start`. Both must
use the same configuration and build identity. `render.yaml` provides a paid
single-service deployment with mounted storage and database-only pre-deploy work.

After the first real HTTPS deployment, register the Pesapal notification:

```sh
node scripts/pesapal-register-ipn.js
```

Save its returned ID as `PESAPAL_IPN_ID` and restart web and worker. Complete a
controlled live payment, callback/IPN reconciliation, cancellation and refund
review. Checkout remains unavailable until the notification ID is configured.

Run deployment smoke with the actual origin and full commit:

```sh
DEPLOY_BASE_URL=https://YOUR_REAL_DOMAIN EXPECTED_BUILD_SHA=FULL_GIT_COMMIT node scripts/deploy-smoke.js
node scripts/launch-evidence.js --list
node scripts/launch-check.js
```

Readiness requires MongoDB, Redis and a completed maintenance cycle from the
exact deployed build. Record genuine provider, scanner, backup/restore, security
and operational evidence through the authenticated evidence workflow. Do not
mark a requirement passed merely to open the gate. Test rollback and recovery
before inviting the pilot group.

## Checks still requiring production evidence

Real provider delivery, production capacity, signed-definition scanner checks,
backups/restoration, infrastructure protection and independent operational
sign-offs must be established on the deployment. The approved palette is
preserved; CI retains and reports the known contrast-only findings as advisory,
while other browser failures remain blocking. Strict accessibility commands
remain available, and this policy is not a WCAG certification. Local passing
functional tests do not remove the launch conditions. Read the latest
verification report in the source repository for exact test scope and results.

For speed, keep the web process, Redis and MongoDB in nearby regions and use
production mode so view and fingerprinted asset caches are enabled. The full
source release includes the measurements in
`docs/audits/2026-10-28-loading-flash-performance.md`; this engineering report is
not part of the smaller production package.

## Troubleshooting the reported local errors

`ENOTFOUND` for a MongoDB Atlas hostname means the configured cluster cannot be
resolved. Copy the current application connection string from that Atlas
cluster, retain an explicit database name, and check DNS/network access from the
machine running Node. Check the Atlas access list and database user separately;
an unresolved hostname is not an authentication failure. Do not switch to an
unrelated database or erase existing data. Restart the application after fixing
the environment.

For local development without Redis, leave `REDIS_URL` blank. Development then
uses MongoDB-backed sessions and its supported local rate-limit fallback. If
Redis is configured, start the specified Redis service. Production always
requires reachable Redis and keeps its distributed protections enabled.

`PESAPAL_IPN_NOT_CONFIGURED` means checkout is correctly refusing an incomplete
gateway configuration. For sandbox testing, use the sandbox credentials and
`PESAPAL_SANDBOX=true`; for production use the live settings above. In both cases
`BASE_URL` must be a reachable HTTPS origin before running
`node scripts/pesapal-register-ipn.js`. Set that environment's returned
notification ID as `PESAPAL_IPN_ID` and restart. A localhost-only callback cannot
receive Pesapal notifications; sandbox and live notification IDs/credentials
are separate.
