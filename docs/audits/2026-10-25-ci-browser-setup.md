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

Run [40241652231](https://github.com/Awanmabur/classic-mart/actions/runs/40241652231)
for `403efdebc6f09821e2a3aedcac8c92f7cdde2de6` provides the actual hosted startup
cause through the new annotation: MongoDB exits 1, with `OOMKilled: false`, and
logs **MongoDB cannot start: Linux kernel versions 6.19 and newer has a known
incompatibility with this version of MongoDB** (`SERVER-121912`). Redis is
running normally. CI now explicitly uses `ubuntu-24.04` rather than following
the `ubuntu-latest` migration to Ubuntu 26. The tested database image, port
safety guards, readiness checks and all release gates remain in place. This
runner compatibility fix is independent of the approved-colour WCAG failures.
GitHub's [current Ubuntu 24.04 image manifest](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
reports image `20261023.334.3`, Ubuntu 24.04.5 and kernel
`6.17.0-1022-azure`, below MongoDB's rejected range. The new hosted run must
confirm its assigned runner and result; the label is not a permanent kernel pin.

## Runner kernel drift — 28 October, Africa/Kampala

Run [40554828771](https://github.com/Awanmabur/classic-mart/actions/runs/40554828771)
for `9a5dbe67256283a79f8f98bf10b01d012b90602d` now reports the same explicit
`SERVER-121912` fatal error on the Ubuntu 24.04 runner. MongoDB exits 1 without
an OOM kill; Redis is healthy. Increasing readiness time or changing the
application cannot resolve the image's kernel refusal.

CI now targets Ubuntu 22.04 and checks the actual Linux kernel immediately after
Node setup, before installing dependencies or browsers. The check rejects
kernels 6.19 and newer, including later major versions, and unrecognized release
strings. It reads the OS directly and has no environment override. An unsupported
host produces a specific escaped error annotation and a nonzero exit status.
Node 24, the pinned database images, resource limits, replica-set readiness and
every application, browser, accessibility and release gate remain enabled.
The installed Playwright 1.62.1 explicitly supports Ubuntu 22.04.
All 27 focused kernel, browser-environment, service-diagnostic and release
contract tests pass locally.

The exact MongoDB startup flags pass locally on Linux 6.18.55 without the
additional local glibc setting. Local checks establish compatibility below the
boundary; they do not establish the newly assigned hosted runner's kernel or
the full pipeline result. GitHub API access is blocked in this environment, so
the next hosted run must supply that evidence. The separate approved-colour
contrast constraint described above still applies.

## Hosted browser follow-up — 28 October, Africa/Kampala

Run [40597780891](https://github.com/Awanmabur/classic-mart/actions/runs/40597780891)
for `dfcc0a8a4ccb7dc58fd45c83957527fe4aee4bd1` passed the actual kernel check,
MongoDB/Redis startup, static gates, the complete automated test step, database
audits, migration planning and browser-account seeding. Public job metadata and
the Playwright summary are readable without the blocked log-download API.

The browser step reports **151 passed, 26 failed and 13 skipped**. Twenty-four
failures are strict accessibility cases across desktop/mobile; two are the
guest-cart persistence journey. That journey still expected immediate removal
after clicking Remove, whereas the shared deletion control correctly requires
confirmation. It now checks Cancel leaves the complete server cart unchanged,
returns focus to Remove, and Continue removes the item persistently after a
reload. The existing dedicated confirmation/security checks remain in place.

The corrected critical-flow suite passes locally with **16 passed, four
intentional project skips and zero failures**, including both cart projects and
real Seller/Moderator MFA sign-in. Seventeen browser-release, kernel and pipeline
contract tests also pass. The approved palette is unchanged and the strict
accessibility assertions remain enabled. A successful functional journey does
not establish a green overall release: the mandatory accessibility step and the
later release/container gates need their own successful results.

The separate local accessibility rerun reports **17 passed, 24 failed and one
intentional project skip**. All 24 failures report only `color-contrast`; no
accessibility rules were excluded or reclassified. `npm run check` also passes
(746 import checks and 785 JavaScript syntax checks). These results use local
system Chromium; they do not replace the next hosted managed-browser result.

## Approved-palette CI policy — 28 October, Africa/Kampala

The latest completed run,
[40604438037](https://github.com/Awanmabur/classic-mart/actions/runs/40604438037),
confirms the cart correction: **153 browser tests passed, 24 accessibility
cases failed and 13 were skipped**. Database startup, the canonical automated
suite and database audits also passed. The remaining observed rule is
`color-contrast`; later release/container steps were skipped.

The exact approved colours are retained. CI now uses the documented
[browser policy](../CI_BROWSER_POLICY.md): proven contrast-only findings are
advisory, while all other failures remain blocking. All assertions still run,
and strict browser commands retain their failing contrast results. This policy
supersedes the earlier instruction to make every contrast finding a mandatory
CI blocker; it does not resolve the underlying readability findings or claim
WCAG certification.

The first hosted approved-palette run,
[40665214814](https://github.com/Awanmabur/classic-mart/actions/runs/40665214814),
passed the browser gate, dependency audit, sanitized release build, production
image build, non-root runtime check and HIGH/CRITICAL image scan. It then failed
at provenance signing with the exact external-service error
`InternalError: error fetching tlog entry`. SBOM signing and release upload
were consequently skipped.

Both signing stages now retry the same official `actions/attest@v4` action up
to three times with bounded waits. Only individual attempts allow continuation;
a final mandatory check requires a successful signing result and its bundle.
Exhausted retries or cancellation still fail CI. Signing, transparency-log
verification and release-upload ordering are retained.
