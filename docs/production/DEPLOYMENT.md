# Deployment and Release Runbook

## Runtime
Use Node.js 24.x exactly as declared by `engines`. Production requires a transaction-capable MongoDB replica set/Atlas deployment. Redis is recommended for sessions and distributed runtime state.

## Before deployment
1. Take and verify a database backup/restore point.
2. Generate independent random values for session, token pepper, data encryption, security integrity, origin guard/SIEM/metrics tokens as used.
3. Configure production SMTP, eSMS Africa SMS verification and malware scanner.
4. Configure HTTPS `BASE_URL`, trusted proxy topology and launch countries.
5. Configure Pesapal live API credentials and base URL.
6. Run `npm ci` with Node 24.
7. Run `npm run release:check` in a networked CI environment.
8. Run `npm run migrate:plan`; review counts.
9. Run `npm run migrate:apply` only after backup verification.
10. Run `npm run pesapal:register-ipn`, persist `PESAPAL_IPN_ID`, restart.

## Processes
Web:
```bash
npm start
```
Worker:
```bash
npm run worker
```
Run at least one worker. Multiple workers are supported by atomic lease claiming and unique run keys.

## Monitoring
- `/health/live`: process liveness.
- `/health/ready`: Mongo/Redis readiness.
- `/internal/metrics`: Prometheus text endpoint when `METRICS_TOKEN` is configured; use `Authorization: Bearer <token>`.
- Admin -> Health: business-invariant alerts.
- SIEM: security events in configured HTTP/UDP mode.

## Release artifact
```bash
npm run security:sbom
npm run release:build
```
Produces `dist/classic-mart-v<version>.zip` and `.sha256`. Deploy the sanitized archive/image, never the developer working directory.

## Rollback
Application rollback may use the previous immutable application artifact only if schema changes remain backward compatible. Do not roll back financial data. If a migration changed data, follow the migration-specific recovery plan or restore a verified pre-migration backup in a controlled incident process.
