# Seller account workspace and MFA continuation

## Behaviour

Seller login and generic account entry land at `/seller/overview`. Store settings
remain at `/seller/store`. Personal security, privacy, messages, notifications,
connected apps and personal purchases use the current authorized workspace's
navigation. A Seller sees Seller navigation while configuring personal MFA;
the content and mutations still belong to the signed-in identity.

Workspace selection uses fresh server authorization and active store membership,
not a label, client-selected role or inferred ownership. Customers retain their
existing dashboard. A revoked store selection does not restore Seller access.
Reading account settings neither creates a store nor changes an account's role.
Both password login and successful MFA login refresh platform authorization
before choosing their landing page, so stale role mirrors cannot select a
revoked operational workspace.

When privileged MFA is required, the security route validates `next` against
currently available navigation and retains it through enrollment and errors.
Recovery codes appear once before an explicit Continue action opens the
authorized destination. External redirects, mutation/export endpoints and
unavailable workspace destinations are rejected. The destination performs its
own access checks again. Required MFA cannot be disabled by directly posting to
the hidden disable endpoint. Alternate-case operational URLs receive the same
MFA enforcement as their canonical routes.

The overview uses actual scoped sales, refunds, orders, products, reviews and
store team data. Connected Seller links lead to Seller operations. Unconnected
sections remain unavailable. The approved base CSS, scripts and image assets
remain unchanged; the new overview content uses a separate stylesheet.

## Verification on 2026-10-11

The checks used Node 24, an isolated local MongoDB replica set and actual Chromium
at desktop and mobile widths. Mail/SMS used development sinks. No Gmail, eSMS
or Pesapal provider delivery/payment calls were made.

| Check | Result |
| --- | --- |
| Real Seller MFA enrollment, continuation, rejected redirects and required-MFA disable prevention | 10 passed; zero failures or skips |
| Personal account shells, workspace isolation, revocation and existing Customer contracts | 15 passed; zero failures or skips |
| Final login/grant, alternate-case MFA and approved base asset regressions | 17 passed; zero failures or skips |
| Real scoped Seller overview, payments/refunds, period validation and CSV | 9 passed; zero failures or skips |
| Store settings regression after fixture lifecycle correction | Two runs passed; one test per run, zero failures or skips |
| Critical desktop/mobile browser flows and marketing motion | 21 passed; three intentional viewport-specific skips |
| Fresh-server Customer signup/login, order filters, native phone-country selector and retired dashboard checks | 10 passed; zero failures or skips |
| Warehouse integrity after fixture startup correction | 8 passed; zero failures or skips |
| Project/import, static security, frontend and functionality gates | Passed |

The broad canonical run completed 471 tests: 462 passed and nine failed, with
zero skips or cancellations. All functional Seller signup, login, MFA, account,
overview, store, product and order checks passed. Six HTTP failures came from
reusing a signup fixture server: signup quotas produced 429 responses and the
persisted security block produced 403 responses. The affected checks passed
against a fresh isolated server without weakening those protections. One
warehouse fixture encountered a native MongoDB failure during asynchronous
index creation; waiting for all registered model indexes before transactions
and cleanup fixed its isolated rerun without removing indexes or assertions.

The remaining strict Seller enrollment contrast assertion and its parent result
still fail with the approved original palette. The assertion remains enabled,
and this work does not claim a passing full release suite or WCAG compliance.
See [the public accessibility findings](../public-accessibility.md). Provider
verification and the remaining unconnected role features retain their own
release requirements.
