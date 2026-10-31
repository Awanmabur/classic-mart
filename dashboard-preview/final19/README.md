# Classic Mart — Unified Role Dashboard (Polished Final 19)

This is the standalone Classic Mart dashboard interface. It runs directly in a modern browser and does not require npm, a build step, or a backend server.

## Start

Open `index.html` in a browser. A small static web server is optional.

## Final 19 design standard

The dashboard now uses one consistent Classic Mart visual system:

- primary brand color: `#ff6500`
- current Classic Mart logo and app icon
- Inter/system UI typography
- **full-pill (`999px`) radius** for buttons and single-line inputs/selects; multiline textareas remain deeply rounded
- **32px soft radius** for major surfaces, with stat-like Support and Quick Action cards intentionally held to a clearer **24px rounded rectangle**
- soft neutral surfaces and restrained shadows
- sidebar active state uses a light primary tint, light primary border and soft shadow instead of a solid primary block
- input focus changes the existing border to primary orange; it does **not** add a second outline/ring/shadow
- compound inputs such as global search, table search, coupon entry and workspace selection keep a single outer border
- semantic status pills and circular icon buttons retain their intentional shapes
- responsive operational tables become labelled cards on small screens
- workspace switching stays available on mobile

## Final 19 header cleanup

- Dashboard selection is one native, fully clickable select rather than a layered custom menu.
- The dashboard selector uses a dedicated dashboard-layout icon, so it is no longer confused with Categories.
- The chevron is a simple right-aligned icon with no separate circular bubble.
- At 1366px desktop width the selector remains labelled and Classic AI keeps its text label.
- Classic AI icon sizing is aligned with Categories and the AI drawer avatar uses the same sparkles mark.
- `VISUAL_CHECK_1366.png` records the rendered 1366×768 header/dashboard check used for this release.

## Ten workspaces

The Workspace selector changes navigation, search context, overview, metrics, tables, forms and actions for:

1. Customer
2. Seller
3. Promoter
4. Admin
5. Super Admin
6. Finance
7. Support
8. Warehouse / Fulfilment
9. Moderation / Trust & Safety
10. Business Buyer

The package contains **123 navigable dashboard views**: 13 customer pages plus 110 operational role pages.

## Forms and creation workflows

Final 17 closes the old view-only/create-button gap. Operational create buttons now open real, validated standalone forms rather than only showing a toast.

Page-aware form flows cover priority tasks, analyses, user/admin/seller/promoter invitations, roles, approvals, products, categories, orders and purchase orders, returns, finance cases, commission rules, subscription plans, disputes, reports, audit exports, security incidents, communications, support tickets, inventory movements, dispatch, campaigns, promoter campaign applications, coupons, review cases, content, payouts, messages, promoter links, conversion notes, referrals and brand/seller partnerships.

Settings pages are also role-aware. Finance/Business/Seller/Promoter retain relevant payment settings, while Admin, Support, Warehouse and Moderation receive workspace-operating controls instead of irrelevant payout UI.

Customer forms include working address add/edit, wallet top-up, support tickets and profile settings. Customer payment-method and return actions now also open real standalone forms.

## Classic AI

Classic AI remains a local/demo-only role-aware assistant in this standalone interface. It does not send data externally or execute privileged backend actions.

Shortcuts:

- `Ctrl/Cmd + K` — global search
- `Alt + A` — Classic AI
- `Esc` — close Classic AI or the operational create form

## Important boundary

This ZIP is a **standalone front-end dashboard/interface**, not the production Classic Mart backend. Form submissions demonstrate complete UI flows only. Authoritative permissions, payments, inventory changes, audit history, provider calls, security decisions and persistence must remain server-side in the full Classic Mart application.

See `POLISH_NOTES.md` and `VERIFICATION_REPORT.md` for the exact changes and checks.


## Latest polish

See `FINAL_16_CHANGES.md` for the cumulative Final 17 corrections.
