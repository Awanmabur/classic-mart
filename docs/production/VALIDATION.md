# Validation and Release Evidence

Classic Mart separates **implementation completeness** from **environment certification**. A gate is reported as passed only when it actually executed successfully.

## Required release gates

A production release must pass on Node.js 24 with a transaction-capable MongoDB replica set:

```text
npm ci
npm run check
npm run security:check
npm run frontend:audit
npm run functionality:audit
npm test
npm run db:verify
npm run audit:integration
npm run audit:concurrency
npm run migrate:plan
npm audit --audit-level=high
npm run security:sbom
npm run release:build
docker build --pull ...
```

The GitHub Actions workflow in `.github/workflows/ci.yml` provisions MongoDB 8 as a replica set, Redis, Node 24, runs those database/concurrency gates, performs the dependency audit, builds the SBOM/sanitized ZIP and builds the production container.

## Local validation evidence for this hardened source

At the final hardening stage before packaging, these gates were executed successfully in the available container:

- project/release/static/EJS checker;
- JavaScript import/export integrity;
- static security scan;
- frontend audit;
- functionality audit;
- canonical automated test suite (**208/208 passing** after the final catalogue, pagination, invariant-cursor and product-feedback continuation regression locks);
- CycloneDX SBOM generation;
- sanitized release builder content-secret and forbidden-path scans.

The final packaging procedure reruns the locally available gates after documentation/test changes and records the new exact counts/checksum. The final storefront product preview also exposes cursor continuation for verified reviews and answered product questions, so the initial bounded preview does not hide historical feedback.

## Explicit local environment limitations

The working container provides Node 22 rather than the project's required Node 24 and does **not** provide `mongod`, Docker or Podman. Therefore the following cannot honestly be certified locally:

- real Mongo transaction topology verification;
- integration audit against a live replica set;
- real concurrency audit;
- migration dry-run against live MongoDB;
- production Docker image build.

The code/CI contracts for those gates are present, but **deployment approval requires the Node 24 CI job to execute them successfully**.

The local dependency vulnerability request also encountered DNS/network failure reaching `registry.npmjs.org`. This is not evidence of either vulnerabilities or absence of vulnerabilities; networked CI must pass `npm audit --audit-level=high` before deployment.

## Concurrency audit scope

The real Mongo concurrency audit uses a guarded disposable `*-concurrency-test` database and deliberately races:

- active payment-intent uniqueness;
- outbound shipment uniqueness;
- return-shipment uniqueness;
- recurring procurement occurrence uniqueness;
- exact return-line quantity reservation.

The audit must prove the database invariant, not merely observe that normal serial requests work.

## Release artifact evidence

`npm run release:build`:

- copies only allowlisted source/runtime/documentation paths;
- rejects symlinks/root escapes;
- rejects `.env`, `.git`, `node_modules`, `.classic-mart`, storage, logs, prior `dist`, artifacts and coverage;
- scans staged text for private-key/high-risk credential patterns;
- emits `RELEASE_MANIFEST.json` with file SHA-256 hashes;
- emits ZIP SHA-256 beside the archive.

A release with a green local source gate but failed/missing mandatory Node24+Mongo CI is a **release candidate, not deployment-approved production**.
