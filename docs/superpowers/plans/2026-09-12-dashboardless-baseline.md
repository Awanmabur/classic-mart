# Dashboardless Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every previous/recent Classic Mart dashboard and dashboard-specific backend/presentation layer while preserving the production marketplace/domain backend as a clean baseline for a new dashboard design.

**Architecture:** Treat dashboards as a removable delivery layer. Delete the unified/legacy role shells and browser management controllers, trim mixed route modules back to public/customer/headless behavior, and preserve reusable models/services. Add a hard dashboardless regression gate so future work cannot accidentally reintroduce the old dashboard architecture.

**Tech Stack:** Node.js 24+, Express, EJS, MongoDB/Mongoose, Redis optional runtime acceleration, existing Classic Mart service/model modules.

**Spec:** `docs/superpowers/specs/2026-09-12-dashboardless-baseline-design.md`

## Global Constraints
- Start from Classic Mart v2.13.69.
- Do not delete production domain models/services merely because their dashboard UI is removed.
- Preserve payment initiation/status/Pesapal callback/IPN/webhook processing.
- Preserve public storefront, customer account, cart/checkout/orders, rewards, customer trust flows, public attribution and Ask Classic customer features.
- No dashboard placeholder; `/dashboard` must be absent/404.
- No role/workspace selector or dashboard preference state.
- No old workspace fallback presentation.
- Package the result as v2.13.70 only after the dashboardless gate and retained-core gates pass.

---

### Task 1: Dashboardless architecture regression gate

**Files:**
- Create: `test/dashboardless-baseline-v2.13.70.test.js`

**Interfaces:**
- Consumes: current v2.13.69 source tree.
- Produces: static contract that defines prohibited dashboard remnants and required retained core modules.

- [ ] Write tests that assert dashboard engine/routes/assets/views/preferences/redirect helpers and role-workspace presentations are present in v2.13.69 so RED is observed.
- [ ] Run `node --test test/dashboardless-baseline-v2.13.70.test.js` and confirm RED for dashboard remnants.
- [ ] Keep this test as the mandatory final cleanup gate.

### Task 2: Remove dashboard engine and presentation

**Files:**
- Delete: `src/dashboard/**`
- Delete: `src/routes/dashboard.js`
- Delete: `public/dashboard/**`
- Delete: `views/platform-dashboard.ejs`
- Delete: `views/partials/dashboard-*.ejs`
- Delete: obsolete dashboard-only workspace views/assets enumerated by the gate.
- Modify: `src/app.js`

**Interfaces:**
- Consumes: Task 1 prohibited-file list.
- Produces: application with no dashboard mount or dashboard static special case.

- [ ] Remove dashboard import/mount from `src/app.js`.
- [ ] Remove dashboard-specific static cache handling from `src/app.js`.
- [ ] Delete dashboard and old role workspace presentation files.
- [ ] Run Task 1 gate; expect remaining failures only from route/preferences/navigation references.

### Task 3: Remove dashboard navigation/preferences/middleware coupling

**Files:**
- Modify: `src/routes/identity.js`
- Modify: `src/routes/account.js`
- Modify: `src/middleware/auth.js`
- Modify: `src/middleware/csrf.js`
- Modify: `src/middleware/privileged-mfa-paths.js`
- Modify: `src/models/User.js`
- Modify: retained public/account EJS partials/pages.

**Interfaces:**
- Produces: login/onboarding/account navigation with `/` or `/account/profile` targets and no dashboard registry dependency.

- [ ] Replace authenticated/default `/dashboard` redirects with `/` or retained account destinations.
- [ ] Remove `preferences.dashboard` schema/runtime logic.
- [ ] Replace privileged-MFA dashboard-registry dependency with explicit retained privileged/headless path classification.
- [ ] Remove `/dashboard` from CSRF/navigation/footer/legacy links.
- [ ] Rename `privacy-workspace.ejs` to `account-privacy.ejs` and update the account route.
- [ ] Run Task 1 gate and retained identity/account tests.

### Task 4: Remove browser role-management route modules

**Files:**
- Delete/unmount: `src/routes/admin.js`, `business.js`, `logistics.js`, `moderation.js`, `seller.js`, `seller-growth.js`.
- Modify: `src/app.js`.

**Interfaces:**
- Preserves: reusable `src/services/**` and `src/models/**` modules.
- Produces: no Admin/Seller/Business/Logistics/Moderation workspace routes until new dashboards are intentionally built.

- [ ] Remove imports/mounts for the six role-management route modules.
- [ ] Delete route modules after confirming no retained public/core route depends on them.
- [ ] Keep seller-growth service because checkout/storefront/promoter services depend on it.
- [ ] Run import integrity and Task 1 gate.

### Task 5: Trim mixed routes to public/customer/headless behavior

**Files:**
- Modify: `src/routes/promoters.js`
- Modify: `src/routes/payments.js`
- Modify: `src/routes/ai.js`
- Modify: `src/routes/trust.js`

**Interfaces:**
- Preserves: `/r/:token`, retained `/api/v1/...`, customer payment/Pesapal/webhooks, Ask Classic customer/public APIs, customer trust/account flows.
- Removes: HTML/browser management routes under `/promoter`, `/seller`, `/finance`, `/money`, `/operations`, `/admin` that existed only for removed workspaces.

- [ ] Add route-contract tests for retained public/headless endpoints and forbidden old management GET surfaces.
- [ ] Trim management-only imports and route definitions.
- [ ] Verify payment/Pesapal webhook routes remain mounted.
- [ ] Verify promoter attribution `/r/:token` remains mounted.
- [ ] Verify Ask Classic/customer AI routes remain mounted.
- [ ] Verify customer returns/disputes/review/support APIs remain mounted.

### Task 6: Clean tests/docs/checkers/release tooling

**Files:**
- Delete: dashboard/workspace-specific tests and dashboard integration specs/plans/docs.
- Modify: `scripts/check-project.js`, `scripts/check-release-scripts.js`, `scripts/audit-frontend.js`, `scripts/audit-functionality.js`, release builders as required.
- Modify/create: dashboardless release documentation.

**Interfaces:**
- Produces: release gates that enforce dashboard absence instead of requiring Final 19/legacy dashboards.

- [ ] Remove historical dashboard tests that intentionally require deleted architecture.
- [ ] Update release/checker scripts to run the dashboardless gate and retained-core validations.
- [ ] Remove dashboard docs and Final 19 dashboard integration docs from the release source.
- [ ] Run project/release/security/frontend/functionality/import gates.

### Task 7: Version and package v2.13.70

**Files:**
- Modify: `package.json`, `package-lock.json`.
- Create: `docs/FULL_VERIFICATION_v2.13.70.md`, `RELEASE_NOTES_v2.13.70.md`, `docs/SBOM_v2.13.70.cdx.json`.

**Interfaces:**
- Produces: engineering, clean and production dashboardless archives.

- [ ] Set version 2.13.70.
- [ ] Generate SBOM and verification docs.
- [ ] Run dashboardless gate, retained-core focused tests, project/release/import/security/frontend/functionality gates, then full runnable source suite.
- [ ] Build engineering/clean/production archives.
- [ ] Independently verify every manifest hash and ZIP CRC.
- [ ] Inspect all three archives to prove dashboard engine/assets/views/old workspaces are absent and retained core routes/services are present.
- [ ] Publish final SHA-256 checksums and handoff artifacts.
