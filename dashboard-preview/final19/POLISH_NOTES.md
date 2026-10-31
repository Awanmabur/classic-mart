# Classic Mart Standalone Dashboard — Polish Notes

## Polished Final 17

Final 17 builds cumulatively on Final 12 and concentrates on consistency, roundness, form completeness and interaction quality.

### Rounder component system

- Standard buttons, inputs, selects and textareas now use a 16px control radius.
- Main cards/panels use a 24px surface radius.
- Secondary containers use an 18px radius.
- Circular icon controls and semantic pills retain their intentional shapes.
- Previously inconsistent one-off radii are overridden by the shared design tokens.

### Clean input focus behaviour

- Active inputs now change the **same existing border** to Classic Mart orange.
- Removed the additional focus box-shadow/ring that looked like a second border.
- Search, operational table search, coupon entry and workspace selection use one composite border only.
- Keyboard focus indication remains on buttons/links for accessibility without creating double input borders.

### Sidebar active state

- Replaced the solid-orange selected menu item with a light primary-orange tint.
- Added a subtle primary border and soft primary shadow.
- Active sidebar items use the same rounded family as other controls.
- Icons and labels use primary orange on the light active surface.
- Role settings sub-navigation follows the same visual language.

### Real operational creation forms

The previous generic `Add new` / `Create` buttons mostly produced only a toast. They now open a reusable validated create-form system with page-specific fields and guidance.

Dedicated form configurations cover every applicable operational page kind, including campaigns, campaign-market applications, finance cases, inventory movement, dispatch, reports, security incidents, permissions, seller/promoter onboarding, support, content and payouts.

Seller product creation remains the richer multi-section product editor rather than being reduced to the generic form.

### Role-aware settings

Generic role settings were corrected so unrelated workspaces no longer inherit promoter-style audience/payment wording. Admin, Support, Warehouse, Moderation and platform operations receive workspace controls; financial/business roles retain relevant payment settings.

### Customer interaction completion

- Add-address remains a real form.
- Edit-address now loads the selected address into that form and saves the update.
- Payment-method Add/Edit actions open a proper standalone form.
- Start Return / Return Item actions open a return form.
- Existing wallet, support and profile forms are preserved.

### Architecture

The visual overrides remain centralized in `design-system.css`. Operational route/configuration remains data-driven in `role-workspaces.js`, and customer interactions remain in `script.js`.

### Curvature correction
- Primary/secondary/text action buttons now use a true pill radius (`999px`).
- Text inputs, selects, search shells and other compound controls use a 24px near-capsule radius on desktop and 23px on phone.
- Textareas keep the same 24px curved language without becoming visually distorted.
- Sidebar and settings navigation use a 22px soft radius, including the light-primary active state.
- Mobile no longer falls back to the older 15px control radius.
- Input focus remains a single border-color change with no second outline or focus ring.


### Final 17 — full capsule geometry
- Single-line inputs and selects now use a true 999px capsule radius, not 23–24px rounded rectangles.
- Buttons, tabs, action chips, search shells and sidebar/settings navigation use the same full capsule geometry.
- One-line controls are 50–52px high so the curvature is clearly visible on desktop and phone.
- Textareas use a deep 30px radius; large panels use 32px; secondary surfaces use 26px; create dialogs use 36px.
- Active sidebar rows remain softly tinted/shadowed in Classic Mart orange and are now fully pill-shaped.
- Focus remains a single border recolor only; no extra ring, outline or second border is added.

## Polished Final 17

- Wishlist page now uses a deliberate four-card desktop grid, with responsive 3/2-card fallbacks.
- Customer Support Centre topic cards now use the same statistic-card surface language as the rest of the customer dashboard and are explicitly excluded from pill-control geometry.
- Dashboard/workspace selection was simplified to one clean selector with a grid icon, role-specific “Dashboard” labels, a stable chevron, and a compact touch target on phone layouts.
- Classic AI now uses a dedicated sparkles icon instead of the generic star, with normalized header, drawer-brand, and response-avatar alignment.
- Seller, Promoter, Admin, Super Admin, Finance, Support, Warehouse, Moderation, and Business settings pages now reuse the customer Profile Settings composition: profile summary, completion indicator, section navigation, verified form panel, communication preferences, and Password & Security area.
