# Customer Dashboard Final 19 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one production Customer dashboard, exactly based on Final 19, with all 13 Customer pages connected to real Classic Mart data/actions.

**Architecture:** Add one Customer-only dashboard registry/router/loader/shell. Keep the supplied CSS byte-identical and replace the demo runtime with server-rendered authenticated data and narrowly scoped Customer JavaScript. Add missing Customer address, notification preference, wallet top-up, and Club backend behavior without introducing later-role dashboard code.

**Tech Stack:** Node 24, Express, EJS, MongoDB/Mongoose, Zod, Pesapal API 3.0, existing Classic Mart services.

**Spec:** `docs/superpowers/specs/2026-09-12-customer-dashboard-final19-design.md`

## Global Constraints
- Customer only; do not scaffold Seller or later workspaces.
- Preserve uploaded Final 19 source CSS byte-for-byte.
- No demo/localStorage business state or role impersonation.
- Page-scoped queries only.
- Real persistence + audit + CSRF + ownership + idempotency.
- Package v2.13.71 and stop for approval.

---

### Task 1: Customer dashboard architecture contract
- [ ] Write RED contract for 13-page registry, Customer-only router, exact CSS, single shell, and absence of later-role dashboard code.
- [ ] Run RED.
- [ ] Implement registry/router/shell skeleton and copy exact assets.
- [ ] Run GREEN.

### Task 2: Page-scoped Customer data
- [ ] Add loader tests for overview/orders/wishlist/categories/cart.
- [ ] Implement page-scoped loaders using existing order/catalogue/cart models/services.
- [ ] Verify no hidden-page preload.

### Task 3: Addresses
- [ ] Add ownership/default-invariant tests.
- [ ] Implement audited CustomerAddress CRUD.
- [ ] Wire Final 19 Addresses forms/actions.

### Task 4: Rewards and Classic Club
- [ ] Add loyalty/club tests.
- [ ] Implement real points/tier/spend summary.
- [ ] Wire Rewards and Club pages without fake redemption.

### Task 5: Wallet
- [ ] Add RED tests for Pesapal top-up intent, provider verification, idempotent ledger credit, callback mismatch, and no card storage.
- [ ] Add WalletTopUp model/service/routes and Pesapal integration.
- [ ] Wire Wallet page.

### Task 6: Returns and Support
- [ ] Bind existing return/dispute/support services to Final 19 pages.
- [ ] Keep ownership, eligibility, trust appeal, and audit controls.

### Task 7: Profile and Notifications
- [ ] Add notification preference schema/routes with audit.
- [ ] Reuse real profile/password/MFA/account flows through safe dashboard return paths.
- [ ] Wire notifications read/preferences UI.

### Task 8: Final 19 Customer shell
- [ ] Build exact header/sidebar/page partial using supplied class structure.
- [ ] Add minimal Customer UI JS only for drawer/tabs/filter convenience.
- [ ] Ensure every control has a real server destination.

### Task 9: Release gates
- [ ] Update project/release/frontend/security checkers for Customer-only dashboard architecture.
- [ ] Run focused Customer tests, core regression, imports, security, frontend, functionality, full suite.

### Task 10: Package and stop
- [ ] Bump to v2.13.71, generate notes/verification/SBOM.
- [ ] Build engineering/clean/production archives.
- [ ] Independently verify manifests, CRCs, exact CSS hashes, Customer-only dashboard files.
- [ ] Send artifacts and stop before Seller.
