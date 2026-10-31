# Classic Mart Standalone Dashboard — Polished Final 19 Verification

## Requested header fixes

- Dashboard selector rebuilt as a native `<select>` with one clean pill surface.
- Dedicated `i-dashboard` icon replaces the duplicated Categories grid icon.
- Right chevron has no bubble and is pointer-transparent, so the select beneath remains fully clickable.
- 1366px desktop selector measured at 236 × 46 px.
- Classic AI remains labelled at 1366px instead of collapsing to icon-only.
- Classic AI and Categories header icons use a consistent 17px optical size.
- AI drawer avatar uses `i-sparkles` consistently.

## Interaction verification

- Native dashboard select contains all 10 workspaces.
- Programmatic `change` event test Customer → Finance updated `body[data-workspace]`, select value, and profile role to Finance.
- Native select retains browser keyboard and pointer behavior without a custom dropdown event layer.

## Visual verification

The package was rendered in Chromium by injecting the exact HTML/CSS/JS and local assets into a blank document because direct localhost navigation is blocked by the execution environment. At 1366 × 768, the selector icon, label, chevron, Classic AI button, Categories button, notification actions, and profile control were inspected together. Evidence is packaged as `VISUAL_CHECK_1366.png`.

## Deterministic checks

- `script.js`, `role-workspaces.js`, `enhancements.js`: syntax PASS.
- Duplicate HTML IDs: PASS.
- SVG symbol/reference integrity: PASS.
- Local assets referenced from HTML/CSS: PASS.
- Role-route uniqueness: PASS.
- CSS brace balance: PASS.
- ZIP CRC/integrity: verified after packaging.
