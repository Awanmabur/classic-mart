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
