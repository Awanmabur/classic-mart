# Exact Final 19 Dashboard Preview

This preview intentionally uses the uploaded **Classic Mart — Unified Role Dashboard (Polished Final 19)** exactly as supplied.

## Run it

```bash
npm run dashboard:preview
```

Open:

```text
http://127.0.0.1:4173
```

## Important boundary

This preview does **not** start `src/server.js` and does **not** import any Classic Mart application code. It does not connect to MongoDB, Redis, authentication, sessions, payments, orders, wallet data, or any other backend service.

The complete original dashboard is stored under:

```text
dashboard-preview/final19/
```

The files in that directory are copied byte-for-byte from the uploaded Final 19 ZIP. Do not modify them during design approval. Backend binding should only begin after the static dashboard is approved.
