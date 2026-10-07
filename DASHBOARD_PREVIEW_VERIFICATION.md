# Exact Final 19 Static Dashboard Preview — Verification

This package intentionally adds the uploaded **Classic Mart Unified Role Dashboard — Polished Final 19** as a static, disconnected preview before any database/backend binding.

## What was added

- `dashboard-preview/final19/` — byte-for-byte copy of the uploaded Final 19 dashboard.
- `scripts/serve-exact-dashboard-preview.js` — isolated Node built-in HTTP static server.
- `npm run dashboard:preview` — preview command.
- `DASHBOARD_PREVIEW.md` — run instructions.

## What was not changed

No existing Classic Mart application/runtime source file was changed. Compared with the supplied `classic-mart-v2.13.74-final.zip`, the only pre-existing file changed is `package.json`, solely to add the `dashboard:preview` script.

The preview server does not import `src/server.js`, Mongoose, Redis, Express, sessions, dotenv, payments, authentication, or any application module.

## Verification

- Final 19 copied files: **39**
- Missing files: **0**
- Extra files inside copied Final 19 directory: **0**
- Changed Final 19 files: **0**
- Original Final 19 `FILE_MANIFEST.sha256`: **PASS**
- Network/backend calls in copied HTML/JS/CSS (`fetch`, XHR, WebSocket, axios, HTTP URLs): **0**
- `npm run dashboard:preview`: **PASS**
- Served `index.html`: byte-for-byte identical to uploaded `index.html`
- Sample served CSS/JS/assets: byte-for-byte identical

## Run

```bash
npm run dashboard:preview
```

Then open:

```text
http://127.0.0.1:4173
```

This is a design-approval checkpoint only. Database/backend integration should begin only after this exact static dashboard is approved.
