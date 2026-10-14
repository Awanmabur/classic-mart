# Staged launch operations

This checkpoint preserves the approved storefront and connected role dashboards.
It is a launch candidate, not a completed production sign-off. Configure and
verify real infrastructure and provider delivery, resolve the launch gate, and
run a controlled pilot before accepting public orders. Application tests cannot
certify payment-provider approval, independent penetration testing, production
capacity, legal review, search rankings or AI indexing.

## Released surfaces and visual scope

Production public registration defaults to `customer,seller,promoter` through
`PUBLIC_REGISTRATION_TYPES`. A subset can be configured; unfinished Business and
Delivery registration cannot be enabled in production. Staff access is invited,
scoped and independently approved. Unsupported operational screens return their
controlled unavailable response instead of rendering another role's dashboard.

Homepage and category photographs retain their original component geometry,
including circular category pictures, product frames and gallery thumbnails.
Only the small homepage promotional banners have larger corners: 32px frames
and 24px photos. Dashboard buttons use the frozen approved typography, padding,
colors and corners, with narrow adapters for real forms and mobile placement.
The genuine homepage cart/red-bag artwork supplies all favicons and PWA icons.

The cleanup removes 27 confirmed obsolete files (470,090 bytes), including the
superseded Customer dashboard implementation, unused asset engines and stale
generated manifests. Approved design references and engineering tests stay in
the source archive; runtime production packages exclude previews, prototype
engines, development seeds, tests, local state and secrets. Future domain code
that is still referenced by tests or services is retained.

## Configuration and startup

Use Node 24 and the committed lockfile. Follow `PRODUCTION_SETUP.md` and replace
every example value in `.env.production.example` using the deployment secret
manager. Never put credentials in Git, command-line arguments, tickets or chat.
Set the actual public HTTPS origin as `BASE_URL`, select `LAUNCH_COUNTRIES`,
and supply a full deployed Git commit as `BUILD_SHA`.

Production needs transaction-capable managed MongoDB; Redis; private R2; mounted
temporary export storage; scanning; SMTP; eSMS Africa; Pesapal; SIEM; and the
session, encryption, token and integrity keys required by environment validation.
For Gmail, use an app password with account two-step verification and TLS SMTP
(465 with `SMTP_SECURE=true`, or 587 with STARTTLS). Provider acceptance and
actual inbox/SMS delivery must be tested with the configured account and sender.
The SMS provider is eSMS Africa; there is no Twilio fallback.

```sh
npm ci
NODE_ENV=production npm run migrate:plan
NODE_ENV=production npm run migrate:apply
NODE_ENV=production npm run bootstrap:production
NODE_ENV=production npm run production:data-check
NODE_ENV=production npm run media:r2:check
```

Publish your reviewed catalogue, prices and physical stock. Bootstrap creates no
marketplace inventory; a data-marker check does not verify that inventory exists.

Run the web service and maintenance worker with identical configuration and
`BUILD_SHA`. `/health/ready` requires MongoDB, Redis and a successful completed
maintenance cycle from that exact build within three minutes. A running process
or open port does not establish readiness. Use deployment smoke with the exact
expected commit:

```sh
DEPLOY_BASE_URL=https://YOUR_REAL_DOMAIN EXPECTED_BUILD_SHA=FULL_GIT_COMMIT npm run deploy:smoke
```

Smoke rejects redirects, mismatched versions, unhealthy dependencies and HTML
that is not the actual catalogue. The launch gate remains a separate sign-off.

## Provision staff without an unfinished admin screen

Bootstrap is an explicit trusted operator action. An existing `ADMIN_EMAIL` must
already belong to an active Super Admin; bootstrap never promotes an ordinary
account or reactivates an inactive account. First-time bootstrap provisions the
trusted identity as verified; independently check ownership before supplying its
email/phone. Remove `ADMIN_PASSWORD` after verifying that operator's login.

Independent staff approval needs two different trusted administrators. Deliberately
bootstrap the second trusted Super Admin with its own temporary `ADMIN_EMAIL`,
`ADMIN_PHONE`, `ADMIN_PASSWORD` and `ADMIN_NAME` bindings, then restore the intended
deployment bindings. Each operator signs in and enrolls its own MFA through
`/account/security`. Do not share passwords, authenticators or recovery codes.

The CLI accepts fresh operator credentials through hidden terminal input, or
stdin JSON `{actorPublicId,password,code}` supplied by a secure process. Evidence
and assignment files contain no authentication secrets. Invite and approve
default to dry-run; `--apply` performs the explicit operation. Successful writes
consume the MFA proof once and commit the authority fence, record, outbox and
audit together. Failed transactions consume none of them.

Example invitation file (use the actual active country and intended recipient):

```json
{
  "email": "INTENDED_STAFF_EMAIL",
  "role": "support",
  "operationalCountries": ["UG"],
  "warehouseScopes": [],
  "grantDurationDays": 90,
  "reason": "Approved operational support assignment."
}
```

```sh
npm run staff:access -- invite --input-file /secure/assignment.json
npm run staff:access -- invite --input-file /secure/assignment.json --apply
npm run staff:access -- list
```

The recipient follows the delivered invitation, registers/signs in, completes
required email/phone verification and MFA, and accepts. Acceptance requests
access; it does not activate a grant. A different authorized administrator lists
and reviews the resulting request, then supplies its public ID and version:

```json
{"approvalPublicId":"ACTUAL_APPROVAL_PUBLIC_ID","expectedVersion":0}
```

```sh
npm run staff:access -- approve --input-file /secure/approval.json
npm run staff:access -- approve --input-file /secure/approval.json --apply
```

Supported staff roles are Country Admin, Finance, Moderation, Support and
Warehouse. Warehouse staff require explicit active warehouse public IDs in the
selected countries. Other roles cannot receive warehouse scopes. Country Admin
operators cannot create Finance/Country Admin access or assign outside their
country. This tool cannot approve unrelated payments, refunds or CMS requests.

## Record actual launch evidence

All 19 existing evidence gates still require a current `passed` result, and open
high/critical findings block launch. `not_applicable` does not satisfy a required
gate. Missing, invalid, future, expired or over-age verification does not pass.
Recovery proof additionally needs measured RPO/RTO and ordered timestamps within
the configured disaster-recovery policy.

```sh
npm run launch:evidence -- --list
npm run launch:evidence -- --file=/secure/evidence.json
```

Listing writes nothing. The default file operation checks format and policy
without database access. It neither fetches a report nor verifies its contents.
Use a permanent, access-controlled HTTPS report URL without credentials, query
tokens or fragments. Every submission binds its source to exactly one gate.

```json
{
  "key": "load-test",
  "expectedVersion": null,
  "status": "passed",
  "reason": "Operator reviewed the actual completed load-test report.",
  "source": {
    "key": "load-test",
    "url": "https://YOUR_REPORT_HOST/reports/ACTUAL_REPORT_ID",
    "description": "Actual workload, measurements, acceptance criteria and findings.",
    "performedAt": "ACTUAL_COMPLETED_ISO_TIMESTAMP"
  },
  "validUntil": "ACTUAL_FUTURE_ISO_TIMESTAMP_WITHIN_POLICY"
}
```

Use `expectedVersion:null` only when the record is absent; use the current listed
integer for an existing record. Never change a real result to pass a gate. A
current global Super Admin can explicitly apply the reviewed report using fresh
password/MFA:

```sh
npm run launch:evidence -- --file=/secure/evidence.json --apply
NODE_ENV=production npm run launch:check
```

The tool records an operator attestation and immutable audit, not an independent
certification. No launch evidence or real staff invitation was applied while
developing this checkpoint.

## Performance, logging and discovery

Production rate limits use atomic Redis counters shared by every web process.
Keep the existing limits enabled. The application Redis ACL needs the operations
used by sessions and rate limiting, including `EVAL`; store errors fail closed.
Do not use independent per-process limits as a production substitute.

Content-fingerprinted static assets receive immutable caching. Unversioned
scripts/styles revalidate sooner; icons and manifests revalidate to pick up the
genuine logo. Public country responses vary by Cookie and CF-IPCountry. Private
responses and errors are no-store. Sitemap queries and caches are bounded.

`LOG_LEVEL=info` retains useful startup/operational warnings and errors. Routine
successful HTTP requests, static files and idle worker cycles produce no access
noise. Enable `LOG_HTTP_ACCESS=true` only when required; it records safe declared
route templates, method, status and timing. It never records raw query tokens,
credentials, request bodies or personal contact details. Security/audit records
remain separate and intact.

Public pages have canonical metadata, crawlable catalogue content, factual
structured data, market-aware paginated sitemaps, robots and `llms.txt`. Private,
authentication and search/filter surfaces remain non-indexable. Missing or
unpublished public records return 404. None of this guarantees ranking or AI
inclusion. See `docs/seo/keyword-research.md` in the full source for observed
autocomplete wording and the blocked Trends request. Suggestions are not search
volume or verified trends and are never automatically injected into pages.

## Current verification limits

The local environment has no configured public domain or real production
MongoDB/Redis/R2, Gmail, eSMS or Pesapal credentials. Local isolated fixtures
exercise application behavior; real provider delivery, production load,
infrastructure protection, disaster recovery and independent sign-offs remain
launch prerequisites. Consult the checkpoint verification record for actual
test counts and failures rather than treating a documented command as executed.
