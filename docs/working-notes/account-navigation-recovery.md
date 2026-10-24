# Account navigation recovery — 24 October 2026

The live profile popup now lets its actions reach the delegated navigation and
logout handlers. Personal profiles render the approved profile controls inside
the currently authorized operational shell. Ordinary Customer profile aliases
still use `/profile`; operational personal profiles use `/account/profile`.
Seller store settings remain a separate authorized destination.

Owned private photos appear in operational headers and personal settings. Photo
upload, deletion and profile saves return to the same personal profile. Return
destinations are a fixed allowlist. CSP permits local image object URLs for the
preview while retaining the existing script, connection and frame restrictions.
Warehouse headers no longer read or provision irrelevant buyer balances.

Current executable evidence:

- The external Customer recovery suite passed all six checks: complete owned
  history, concurrent address defaults, exact cart variant moves and rollback,
  full wallet CSV, sanitized private avatars and durable cleanup.
- Chromium passed the actual Customer signup, popup Security/Profile, address
  creation/edit, local photo preview/save/delete, mobile navigation and logout
  journey without browser errors.
- Seller personal-account checks passed all ten checks, including profile saves,
  private 320px photo ownership, operational role shells, explicit accepted staff
  selection, immediate revocation, and desktop/mobile popup navigation.
- Seller store settings passed with current Device/MFA authority, revoked owner
  membership denial, concurrent initial provisioning, rollback and locked-store
  read-only settings. Existing owner membership metadata is unchanged by reads.
- The project/import/syntax and static security gates passed. Public SEO checks
  confirmed actual published product links, canonical/schema markup, readable
  content without JavaScript, missing-product 404, published-only sitemaps and
  private-page crawl exclusion.

These are local recovery checks, not a production release certificate. The full
canonical regression, integration/concurrency, public UI and launch checks still
need their own current results. Provider delivery requires configured credentials.
