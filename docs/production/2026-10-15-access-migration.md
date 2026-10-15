# Staff-access migration and catalogue focus — 15 October 2026

This follows the [runtime checkpoint](2026-10-15-runtime-followup.md).
It covers the completed fixes below; production deployment and real provider
certification remain separate requirements.

## Staff-access migration

The former `migrate:apply` could create a new 180-day grant when a managed staff
account's existing grant had expired. A stale `User.role` mirror was sufficient
to mint the new grant, despite request authorization correctly rejecting the
expired authority. The committed pre-fix code reproduced this behavior against
synthetic records in a fresh isolated MongoDB database: an expired managed
Finance account received a second, currently active grant.

The migration now distinguishes a one-time legacy upgrade from approved staff
provisioning. Existing management markers, including explicit null, or any grant
history prevent minting a replacement when there is no current grant. Inactive
accounts retain their state. Current grants synchronize their existing role and
scope without extending expiry, capabilities or warehouse access. A genuine
active unmanaged legacy account with no grant history can still upgrade.

Identity, grant and sponsoring administrator checks are fenced within each
MongoDB transaction. Revocation or concurrent changes cause a recheck; a failed
grant insertion rolls back the management marker. Sponsorship follows actual
current global authority, including a managed administrator whose compatibility
role mirror says Customer. A missing/null management marker with a stray grant
does not establish that authority. Legacy Super Admin scope handling is
consistent regardless of processing order. Sponsor lookup uses aggregation
within the transaction to retain mongos compatibility.

Ambiguous records appear as public IDs and reason codes in
`result.platformGrants.reconciliation`. Samples are capped at 100, while totals
and omitted counts remain accurate. Existing certification guards return exit
code **2** for unresolved failures/conflicts. Operators review those identities
through the authenticated staff workflow; approved renewal remains an explicit
staff-access action. General user migration also stops guessing operational
scopes before this authorization check.

Database connection setup also ties automatic collection creation to automatic
indexing by default. Production and CLIs using `autoIndex:false` now use
`autoCreate:false`; explicit migration/index commands retain schema ownership.
Before this fix, an actual read-only plan against a fresh synthetic database
returned success but created **134 collections**. The same probe afterward
returned success with **zero collections**. Development's automatic setup remains
available. This removes competing background collection commands from CLI
transaction startup and reduces production startup work.

After conflict preflights, apply explicitly prepares a missing PlatformGrant
collection outside the per-user transactions. This avoids implicit collection
creation inside a cross-shard transaction on legacy deployments. The regression
checks the missing-collection path and preparation order against the local
replica set; an actual sharded-cluster run remains unverified here.

## Catalogue keyboard focus

The catalogue sort selector reset its outline and had no visible keyboard focus
indicator. Its existing desktop/mobile regression failed on `SELECT` before the
fix. The selector now uses the same soft orange focus shadow as the approved
catalogue price/search controls, only while `:focus-visible` matches. Both
viewport cases then passed with the existing assertion unchanged.

No hero-dot spacing or marketing palette changes are included. Independently
enlarging the tightly spaced dot targets would require wider spacing; overlapping
invisible targets would not be a valid repair. Public contrast, hero targets and
full strict WCAG certification retain their documented limitations.

## Verification scope

Real MongoDB regressions cover history/management markers, inactive accounts,
valid grants, legitimate legacy staff and Super Admin upgrades, Customer role
mirrors, recipient/sponsor revocation races and transaction rollback. The actual
CLI default dry run preserves identities and grants; `--apply` reports unresolved
expired access and returns exit 2 without renewing it.

One post-install authority run passed the migration cases but failed the existing
staff invitation CLI apply case with a generic `STAFF_OPERATION_FAILED` error
(including its parent result). A temporary isolated diagnostic hook, restricted
to error classifications without messages or secrets, passed that entire
ten-entry staff file. The original error did not reproduce, so its exact cause
was not established. The separate background-DDL defect above was demonstrated
directly and fixed; it is not claimed as a proven cause of that earlier error.

Fixture databases are newly generated, loopback-only and dropped after use.
The pre-fix reproduction uses synthetic records, not production accounts.
No real staff grant, provider message, production migration or deployment was
performed. See the preceding checkpoint for the canonical suite's measured
results and the still-unconfigured production services and launch requirements.

Final checks against this source, after executing the complete cloud install
script with frozen dependencies:

| Check | Result |
| --- | --- |
| Authority group: migration, staff operations, release safety and bootstrap | 43 passed; zero failures/skips |
| Release/packaging contracts | 104 passed; zero failures/skips |
| Index maintenance, including explicit collection-creation policy | 4 passed; zero failures/skips |
| Existing catalogue keyboard-focus browser regression | 2 passed: desktop and mobile |
| Public layout browser regression | 72 page visits, 42 controls, zero reported issues |
| Security, frontend and functionality static audits | Passed |
| Locked dependency audit | Zero reported vulnerabilities |
| Production and clean runtime packages | Both installed frozen production dependencies and passed real HTTP/import checks |

Both runtime packages contain every advertised entrypoint. Importing the migration
module is safe and does not execute the CLI. The email/SMS verification commands
reject missing configuration with their expected errors. Package checks include
ZIP CRCs, complete manifests, every file's digest and current source bytes;
runtime package/lockfile and clean README transformations are intentional.

| Package | Manifest files | ZIP bytes | SHA-256 |
| --- | ---: | ---: | --- |
| Production | 664 | 2,734,179 | `26e75cc4e153f9706af405b943af35eae4f7d462faa89e23d42a8c54c56f0ce0` |
| Clean | 670 | 2,741,018 | `06f7ec16f19dc672ba61f76b2a21fe3b54a3f0e731fe57274655ac9cfe9f5901` |

Counts overlap and must not be added together. The complete canonical suite was
not rerun in this follow-up; its earlier measured result remains in the preceding
checkpoint. Passing these checks does not establish real provider delivery,
full WCAG conformance, production capacity, a complete scanned production image,
deployment or independent launch approval.
