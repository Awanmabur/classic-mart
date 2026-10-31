# Production Launch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Produce a clean production Classic Mart artifact with all categories continuously swipeable, no demo/local data in the launch package, production-only bootstrap, and fail-closed real infrastructure configuration.

**Architecture:** Keep the cumulative engineering source tree intact for tests and maintenance, but add a production allowlist builder that emits only runtime code and launch operations. Production bootstrap creates only real platform primitives (launch countries, taxonomy, Super Admin grant and indexes), while runtime guards reject sandbox/local infrastructure and require mounted persistent storage.

**Tech Stack:** Node.js 24, Express 5, EJS, MongoDB/Mongoose 9, Redis, Pesapal API 3.0, filesystem mounted persistent storage.

**Spec:** User-approved requirements in the current conversation through v2.13.45.

## Global Constraints

- Preserve every cumulative fix through v2.13.45.
- All categories must be reachable in one horizontal carousel by arrow/swipe; original categories remain first.
- Production artifact must exclude tests, local Mongo tooling, reset scripts, demo seed products/users/campaigns, stock-photo downloader, CI/dev-only files and generated local data.
- Production startup must reject Pesapal sandbox mode, missing Redis, and application-local upload/export persistence.
- Production bootstrap must not create fake marketplace activity.
- Do not claim production GO without launch evidence and real provider verification.

---

### Task 1: Category carousel
**Files:** `views/index.ejs`, `public/script.js`, `public/styles.css`, `test/production-launch-cleanup-v2.13.46.test.js`
- [x] Write failing test proving all server and hydrated categories are in one row and More only jumps to the first additional category.
- [x] Run test and observe failure.
- [x] Implement one-row all-category rendering and jump behavior.
- [x] Run targeted tests.

### Task 2: Production persistence and real-provider guards
**Files:** `src/config/env.js`, `src/services/stage9.js`, `src/services/privacy.js`, `.env.production.example`, tests
- [x] Write failing tests for Redis, live Pesapal, and persistent storage requirements.
- [x] Add production-only fail-closed validation.
- [x] Route exports/privacy exports under persistent storage root.
- [x] Verify tests.

### Task 3: Clean production bootstrap
**Files:** `scripts/bootstrap-production.js`, `package.json`, tests
- [x] Write failing tests proving bootstrap contains no Product/Store/Promoter/Review/Order demo creation.
- [x] Implement indexes, launch-country settings, canonical categories and Super Admin grant only.
- [x] Add `bootstrap:production` command and verify.

### Task 4: Production release builder
**Files:** `scripts/build-production-release.js`, `Dockerfile`, `package.json`, tests
- [x] Write failing allowlist/exclusion test.
- [x] Build production artifact containing runtime + approved launch scripts only.
- [x] Exclude local/dev/demo/test/CI artifacts.
- [x] Verify generated tree and ZIP.

### Task 5: Cumulative verification and packaging
- [x] Run targeted cleanup tests.
- [x] Run import/security/frontend/functionality gates.
- [x] Run full source suite and record environment-only failures separately.
- [x] Build source final ZIP, upgrade overlay and production-launch ZIP.
- [x] Verify manifests, CRC, forbidden paths and secret scan.
