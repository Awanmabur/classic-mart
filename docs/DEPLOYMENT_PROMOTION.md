# Classic Mart deployment promotion policy

Classic Mart production promotion is intentionally separate from ordinary CI. CI proves the source/release candidate. The promotion workflow proves that the **exact reviewed commit** is what each runtime environment actually serves.

## Required GitHub environments

Create these GitHub Environments in repository settings:

1. `staging`
2. `canary`
3. `production`

For every environment configure:

- secret `DEPLOY_HOOK_URL` — provider deployment hook for that environment;
- variable `BASE_URL` — public HTTPS origin of that environment.

`canary` and `production` must have required reviewers. Production must not auto-approve itself.

The hosting platform must expose the deployed Git commit through one of `BUILD_SHA`, `RENDER_GIT_COMMIT` or `SOURCE_COMMIT`. `/health/version` reports that non-secret build identity.

## Promotion sequence

`workflow_dispatch` receives the full Git commit SHA to promote. The workflow rejects a SHA that is not already an ancestor of `main`, and it requires a successful CI `push` run for that exact SHA on `main`.

1. **Staging** — deploy hook, readiness wait, version/SHA proof, public smoke.
2. **Canary** — separate deployment target, same exact SHA proof and smoke. This must be a real isolated canary/preview service, not the production URL under another name.
3. **Production** — protected environment approval, deploy hook, exact SHA proof and post-deploy smoke.

A deployment is rejected if the runtime reports another commit, cannot prove a build SHA, fails Mongo/Redis readiness, returns a 5xx public product page, or exceeds the smoke timeout.

## CI artifact assurance

The CI workflow additionally:

- builds the production container with the Git commit embedded as `BUILD_SHA`;
- scans the built image for HIGH/CRITICAL vulnerabilities using Trivy;
- generates the release SBOM and sanitized ZIP;
- generates GitHub/Sigstore provenance attestations for release artifacts when repository permissions support attestations;
- uploads immutable SHA-named release evidence.

GitHub artifact attestations may be unavailable for some private repository plans. In that case the attestation step is skipped only by repository-event condition; production promotion still requires exact commit proof at runtime.
