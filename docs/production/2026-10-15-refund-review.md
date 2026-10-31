# Independent refund review — 15 October 2026

This follows the [refund and account boundary checkpoint](2026-10-15-financial-account-boundaries.md).

Finance can record an independent no-disbursement review on an unresolved
Pesapal refund. The review preserves the full reservation, UNKNOWN provider
outcome, payment balances, inspected return binding and physical quantities.
It records an operator attestation; it does not fetch or independently validate
the provider's records, authorize another payment or cancel the customer's refund.

## Operator workflow

Open the existing refund detail in the Finance workspace. An operator different
from the requester checks final provider evidence showing no paid, accepted or
pending refund, then records its reference and findings. A timeout or a missing
portal record is insufficient evidence. The existing paid-completion form and
its independent-operator rule remain available after the review. Confirm actual
disbursement only after verifying the actual payment reference.

The new form and recorded detail reuse existing approved components. No
stylesheet, palette, button geometry or other dashboard template changes are
included. Review content is escaped and exposed through the scoped Finance DTO;
internal actor IDs are excluded from that response.

## Authorization, consistency and audit

The backend requires current Finance workspace authority, current account/session,
MFA enrollment and country scope. Country Admin and unrelated workspaces cannot
use this action. The requester cannot review their own refund. Version, reference,
substantive findings and explicit terminal-outcome confirmation are mandatory.

One transaction validates the refund, original payment, order/currency and
reservation counters. Completed accounting blocks an initial review. Bound
returns additionally require their exact inspected financial snapshot and source
fences. The action adds an immutable review, one audit event and an escalation;
it leaves financial and physical states unchanged. An exact original-author,
reference, reason and source-version replay is idempotent after current
authorization, including after later legitimate completion. Conflicting reviews
fail. Audit failure rolls back the entire operation.

## Verification and launch scope

The preceding commit's complete canonical run measured 1,221 passed, eight
fixture-dependent skips and zero failures; the skipped files subsequently passed
their separate 11-check live run. Those are historical baseline results, not a
claim that the full suite was rerun for this feature.

All fixtures use generated loopback-only databases and controlled provider
responses. No live provider call, message, refund or production operation is
performed. Real provider certification, signed image scanning, infrastructure,
public accessibility and independent launch-evidence requirements remain as
documented in the preceding checkpoint.


Final current-feature verification, after executing the complete reusable
frozen-lock install script:

| Check | Result |
| --- | --- |
| New independent-review regression | 13 passed, zero failures/skips |
| Existing Finance, order, refund, report and inspected-return regressions | 66 passed, zero failures/skips |
| Release and packaging contracts | 104 passed, zero failures/skips |
| Project/import, security, frontend and functionality gates | Passed |
| Locked dependency audit | Zero reported vulnerabilities |
| Actual browser review submission | Passed at 1366px and 390px; approved button geometry and no horizontal overflow |
| Both runtime ZIPs | Frozen production installation, real HTTP/import/icon checks and declared entrypoints passed |

Coverage includes requester/country/workspace/MFA/version checks, exact replay
and conflicting evidence, immutable review data, return bindings, audit rollback,
concurrent financial-source changes, and later paid completion with exactly one
original-settlement reversal and credit note. Actual HTML/JSON requests enforce
CSRF and return curated private data. Provider-call counters stay zero throughout
review and paid-confirmation scenarios. Browser checks compare the new action's
computed typography, padding and alignment against the existing completion
button and submit the review form at both widths. No stylesheet changed.

ZIP CRCs, complete manifest membership and every file's bytes/digest match the
current source, allowing deliberate runtime package/lockfile and clean README
transformations. Missing-configuration email/SMS CLI checks fail closed. Counts
overlap and must not be added into a fabricated complete-suite result.

| Runtime package | Manifest files | ZIP bytes | SHA-256 |
| --- | ---: | ---: | --- |
| Production | 664 | 2,739,079 | `bd165290bd3784e1677b9e2cbc1f0db70df4c44b02722a6b761ce0adae8343f5` |
| Clean | 670 | 2,745,919 | `c0b03096370e177900c1914ed46a179fc87ffcdcb29e67710c2e9cbb2461fdce` |
