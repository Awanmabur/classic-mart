# CI browser setup and failure reporting — 25 October 2026

GitHub run [40220173454](https://github.com/Awanmabur/classic-mart/actions/runs/40220173454)
for `804d5d5123255a6867eb018d29a52abb0ba514f5` failed in **Automated unit, live
database and workspace browser tests**. Dependency installation, browser
installation and the static/security/frontend/functionality gates passed. The
later integration, accessibility, dependency/container and release gates did not
run. The preceding candidate's CI run also failed; local application validation
is separate from a successful hosted release pipeline.

The run/job metadata is readable. Both GitHub log-download endpoints returned
403 from this environment, including an escalated attempt. Consequently the old
run's individual failing assertions could not be retrieved here. Do not present
source inspection as a downloaded error trace.

## Definite browser portability defect

CI installs Playwright's managed Chromium. Several unconditional live suites
instead fall back to `/usr/bin/chromium`, while other suites only run browser
journeys when `PLAYWRIGHT_CHROMIUM_EXECUTABLE` exists. The cloud verification
machine has that system executable and exports the variable; hosted CI did not.
One Warehouse/Support layout test uses the compatibility variable
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead.

`scripts/prepare-ci-browser.js` now resolves `chromium.executablePath()` from the
installed Playwright package, verifies an executable regular file and appends
both variable names to the existing `GITHUB_ENV` command file immediately after
browser installation. It preserves existing settings and refuses a missing or
symlink-substituted environment file, malformed browser paths and non-executables.
No browser tests are removed; conditional journeys are enabled in CI as well.
Push triggers now name only the retained `master` branch.

## Observable failures with unchanged exit status

The canonical runner keeps its complete spec report and original exit code. In
Actions it also emits escaped failure annotations with the actual cause,
location and stack. Enclosing subtest-failure duplicates are omitted. A real
subprocess regression proves a failed assertion still exits 1, retains spec
output and produces one annotation; a local invocation emits no workflow
commands. Playwright similarly adds its built-in GitHub reporter alongside the
existing line, HTML and JUnit reports. This makes the next hosted failures
visible directly on their check rather than depending solely on log storage.

## Exact-colour constraint

The user explicitly chose **Keep the approved colours exact**. No application
stylesheet, rendered colour, layout or accessibility gate changes are part of
this repair. The existing strict WCAG check remains mandatory.

The approved white/orange `#ff6500` pair has contrast approximately 2.952:1,
below both normal-text AA (4.5:1) and large-text AA (3:1). It is explicitly
required by the approved colour regression and appears in the frozen Final19
design. The previous actual accessibility sweep reported 26 contrast failures;
see [Public accessibility](../public-accessibility.md). Browser setup can be
corrected independently, but it does not make these exact colour pairs pass
WCAG. Do not disable, reclassify or suppress the gate to report a green release.

## Local verification and limits

Eighteen browser-environment, reporter, browser-release and release-pipeline
checks pass. They cover preserving environment settings, unsafe/missing paths,
unchanged nonzero failure exit codes, real runner subprocess annotations and
workflow gate retention. A real local Chromium launch and rendered-page smoke
passes using the exported standard/compatibility paths.

The managed browser's CDN also returns `403 Domain forbidden` here, including an
escalated attempt. The local launch smoke therefore uses the existing system
Chromium, not a falsely claimed download of CI's distribution. The new hosted
run must establish the actual managed-browser result. The earlier full
application run remains 1,427 passed plus 15 separately verified live-context
cases, with 56 passing desktop/mobile browser cases; it does not certify CI.

## Hosted follow-up — 26 October, Africa/Kampala

Run [40225260444](https://github.com/Awanmabur/classic-mart/actions/runs/40225260444)
for `092495182a5a0206e8d7270e027a6b83a34b01e3` successfully installed and
resolved managed Chromium and passed the static/security/frontend/functionality
gates. The new failure annotations expose five live suites rejecting the old
CI MongoDB port: `27018 !== 27019`. This is retrieved assertion evidence,
separate from the earlier source-only browser diagnosis.

The workflow now consistently starts its disposable replica set on port 27019,
including its replica member, readiness probes and all application/live-fixture
URIs. Application/browser fixtures retain `classic_mart_ci`; destructive live
tests retain the separate `classic_mart_ci_test` database and their individually
named disposable databases. Redis remains isolated in database 15 for live
tests. No fixture safety guard or mandatory gate is relaxed. The pipeline
contract also checks that the listener and replica member match the live URI.

The five affected suites and release contracts pass against the existing
isolated loopback replica set: 57 passed, no failures or skips. The hosted
result still needs to establish the subsequent integration,
browser/accessibility and release gates.

Run [40240690079](https://github.com/Awanmabur/classic-mart/actions/runs/40240690079)
for `4b9bdb716f1bf62c35babedf6634ab3b29787564` passed browser installation and
resolution, then failed in database startup before the tests. Its check exposes
only exit code 1; this is not evidence for a particular Docker/MongoDB cause.
Startup now pins the MongoDB and Redis image digests used by the successful
local fixture, caps test-service resources and explicitly requires MongoDB
reachability, a writable replica-set primary and a Redis PONG. Failed readiness
cannot fall through into later steps. The error trap preserves the original
exit code and emits bounded, escaped container-state/log diagnostics directly
on the GitHub check, with the same data retained as a private-mode CI artifact.

The updated startup shell also passes a real fresh-container smoke on separate
local ports 28019/16380, including replica-set transaction-topology verification;
only its labelled containers and anonymous volumes were removed afterwards.
Twenty-one focused CI/browser/reporter/release checks pass, including an actual
subprocess of the workflow startup shell proving Docker exit 42 survives the
diagnostic trap and command-injection text cannot forge annotations.

The later CI commands were additionally executed against newly owned local
fixtures: topology, the twelve-stage integration audit, concurrency audit,
migration dry-run, catalogue seed and real Seller/Moderator MFA seeding all
pass. The complete two-project browser run reports **89 passed, 26 failed,
13 skipped**. Every failing test reports only `color-contrast`, verified from
JUnit. Desktop Seller/Moderator isolation and the mobile Seller phone-card
journey pass. Five skips are intentional desktop/mobile project exclusions;
the other eight require the separate owned simple-customer-login fixture, whose
image/catalogue journeys were already verified in the previous application
checkpoint. These skips are not represented as passes in this CI-style run.
The local browser is system Chromium and video capture is off; hosted managed
Chromium and all remaining release gates still require their own actual result.
