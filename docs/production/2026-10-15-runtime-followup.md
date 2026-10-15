# Runtime hardening follow-up — 15 October 2026

This follows the [cleanup checkpoint](2026-10-14-cleanup-verification.md).
Its historical test counts and archive hashes describe that earlier checkpoint.
This follow-up does not certify a production launch.

## Changes

- Fixed the production supervisor's forced shutdown. Sending SIGTERM sets
  Node's `child.killed` flag before the child exits; using that flag to decide
  whether to send SIGKILL left uncooperative children alive. The supervisor now
  escalates against children still in its active map after the unchanged
  15-second deadline and preserves an unexpected child's failure status.
- Reused one runtime package script map for Docker and the production/clean ZIP
  builders. Docker no longer advertises source-only engineering commands whose
  files or development dependencies are absent. Both ZIPs retain the helper
  needed by their shipped Dockerfile; the final image excludes that build helper.
- Included the existing `mail:verify` and `sms:verify` commands in Docker and both
  runtime packages. They authenticate using environment configuration without
  sending a message. Authentication and available credit do not establish inbox
  delivery, sender approval or successful payment settlement.
- Added upload-time scanner freshness enforcement. Local `clamscan` uses its
  native two-day CVD age check. The daemon path validates its loaded database
  before sending an upload, bounds its response, rejects ambiguous clean
  verdicts and shares one 15-second deadline across metadata and scanning.
  `launch:check` also requires a harmless probe to pass the configured scanner.
- With the user's explicit approval, changed only the seller-enrolment form's
  two small heading labels and submit-button background to the existing approved
  darker orange, `#b94b00`. White-on-orange and orange-on-white contrast is about
  5.16:1. Borders, layout, padding and the marketing/dashboard palette are retained.

## Verification and launch limits

The full seller signup/enrolment regression passed all **10 entries**, with no
failures or skips, against isolated MongoDB and real Chromium. It covers email
verification, correct Seller dashboard landing, later login, existing-customer
enrolment, protected-role boundaries and checked accessibility rules at 390px
and 1366px. The previously failing seller-enrolment contrast assertion remains
enabled and now passes.

The isolated supervisor and existing production-launch checks passed **19
entries**. Four supervisor cases spawn real children, including one that ignores
SIGTERM, and verify forced termination, failure-status preservation, SIGINT and
unexpected successful child exit. Release artifact/pipeline checks passed **10
entries** and build actual temporary ZIPs with provider verification commands.

The subsequent canonical run completed **1,157 entries: 1,147 passed, two failed,
eight skipped**, in 25m13s. Seller enrolment, role/browser workflows, scanner and
supervisor checks passed. The two failures were static assertions still looking
for R2/dev commands inline in the old builders. They now read the same exported
runtime configuration used by the builders. The complete 104-entry release
group then passed, including both affected files; the separate 34-entry runtime
group also passed, with no failures or skips in either rerun. The full canonical
suite was not rerun after those test-only corrections. Its eight skipped cases
require separately running external HTTP fixtures; earlier activated fixture
results are recorded at the cleanup checkpoint.

The complete reusable environment install script then executed successfully:
frozen-lock install, 614-file JavaScript import checks, regenerated helpers and
owned Redis readiness. The regenerated runtime helper again passed all 34
entries afterward. Static security scanned 581 files; frontend/functionality
audits covered 40 EJS views; dependency audit found zero vulnerabilities.

Scanner executable/TCP contract checks passed **27 entries**, including stale,
invalid, oversized and missing metadata, refusal to send upload data after a
failed check, clean/infected/error responses, native exit statuses and the
actual shared timeout. These use controlled executable/protocol fixtures, not
a real ClamAV engine or signed definitions. The native option and daemon format
were checked against official ClamAV 1.4.3 source:
[option](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.3/common/optparser.c#L285),
[age check](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.3/clamscan/manager.c#L1253),
[VERSION](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.3/clamd/session.c#L475),
[timestamp](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.3/libclamav/others_common.c#L376).

Container dependency installation first failed because the base image lacked
the cloud's trusted TLS-proxy CA. Supplying the existing environment CA through
an optional BuildKit secret resolved the failure with TLS verification enabled.
The dependency stage built and installed the frozen production dependencies;
its actual container verified the rewritten manifests, absent development
dependencies and absent CA mount/environment setting. This is a component image,
not the complete production image. Definition fetching now follows the explicit
build SHA, and CI/documented refresh builds use `--no-cache` so an old successful
definition layer cannot silently satisfy a later rebuild.

Both updated runtime ZIPs installed their frozen production dependencies and
passed actual import/HTTP HTML/icon smoke checks without development packages.
Every advertised Node entrypoint and npm-script alias exists. The shipped
provider verification commands execute and return the expected configuration
failure with absent credentials; they do not falsely report authentication.
ZIP CRC, complete manifest file sets, every byte count/SHA-256, source-byte
comparisons and local-state/prototype exclusions passed. Dependencies installed
for the smoke are outside the archived ZIP contents.

| Archive | Manifest files | ZIP bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `classic-mart-v2.13.74-production.zip` | 664 | 2,732,325 | `90338f760dd138313184045b679657eb38d9a53934f06dd690cc6a99fee2d710` |
| `classic-mart-v2.13.74-clean.zip` | 670 | 2,739,166 | `988f4f572d8aae70a066f68471e00dbe690f18d99f5006011fdb3718e9454ecc` |

The broader public palette still has the accessibility limitations documented in
[public accessibility](../public-accessibility.md). Fixing the seller-enrolment
form does not establish site-wide WCAG compliance.

Real domain, launch markets, infrastructure and provider credentials remain
absent in this runtime. The prior official ClamAV definition download was denied
by the network proxy. The saved network draft has not been applied, so this
follow-up does not relabel that blocked full image build as successful. Real
Gmail/eSMS/Pesapal delivery, signed-database malware detection, the completed
image vulnerability scan, production load and launch evidence remain separate
requirements. No production deployment, migration or provider message was sent.
