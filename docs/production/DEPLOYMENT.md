# Deployment and Release Runbook

## Runtime
Use Node.js 24.x exactly as declared by `engines`. Production requires a transaction-capable MongoDB replica set/Atlas deployment and reachable Redis for shared sessions and distributed rate limits. Start with the [launch handoff](LAUNCH.md) and the production environment template.

## Before deployment
1. Take and verify a database backup/restore point.
2. Generate independent random values for session, token pepper, data encryption, security integrity, origin guard/SIEM/metrics tokens as used.
3. Configure production SMTP, Yoola SMS verification and malware scanner.
4. Configure HTTPS `BASE_URL`, trusted proxy topology and launch countries. Review [MFA rollout](MFA.md) before enrolling passkeys; their identity and accepted origin depend on this hostname.
5. Configure Pesapal live API credentials and base URL.
6. Run `npm ci` with Node 24.
7. Run `npm run release:check` in a networked CI environment.
8. Run `npm run migrate:plan`; review counts.
9. Run `npm run migrate:apply` only after backup verification.
10. Run `npm run pesapal:register-ipn`, persist `PESAPAL_IPN_ID`, restart.

## Processes

The Docker image and production archive supervise web and worker together. The
source checkout uses `start:production`; the production archive uses `start`:

```bash
NODE_ENV=production npm run start:production
```

If an operator deliberately runs separate processes from the source checkout,
run both with the same production environment and full `BUILD_SHA`:

```bash
NODE_ENV=production npm start
NODE_ENV=production npm run worker
```

Run at least one worker; do not launch an additional worker merely because the
supervisor already started one. Multiple workers are supported by atomic lease
claiming and unique run keys.

## Monitoring
- `/health/live`: process liveness.
- `/health/ready`: Mongo/Redis readiness and a recently completed worker cycle from the exact deployed build.
- `/internal/metrics`: Prometheus text endpoint when `METRICS_TOKEN` is configured; use `Authorization: Bearer <token>`.
- Admin -> Health: business-invariant alerts.
- SIEM: security events in configured HTTP/UDP mode.

## Release artifact
```bash
npm run security:sbom
npm run release:production
```
Produces `dist/classic-mart-v<version>-production.zip` and `.sha256`. The separate
`release:build` command creates an engineering/source archive with tests and
design references. Deploy the runtime archive/image, never the developer
working directory.

## Rollback
Application rollback may use the previous immutable application artifact only if schema changes remain backward compatible. Do not roll back financial data. If a migration changed data, follow the migration-specific recovery plan or restore a verified pre-migration backup in a controlled incident process.
