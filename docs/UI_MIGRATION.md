# UI migration contract

## Preserve

- Existing page hierarchy, responsive rhythm and navigation placement
- Rounded cards, pill buttons, rounded inputs and consistent focus states
- Orange, teal, navy, blue and neutral Classic Mart palette
- Readable text sizes, clear spacing and mobile-first behaviour
- Existing local icon set and product placeholders

## Enforce

- Native EJS templates (`views/*.ejs`) with extensionless `res.render()` names
- Clean public routes (`/products`, `/help`, `/signup`) instead of `.html` navigation
- Root-relative bundled assets (`/assets/...`, `/styles.css`) so nested routes render consistently

- No gradients
- One clear primary action per workflow
- Real data or an honest empty/error/denied state
- Keyboard operation, labels, focus visibility and reduced-motion support
- Server-rendered escaped content by default
- No role, price, stock, payment or order trust in browser code

## Migration checklist

1. Freeze the current screen as the visual reference.
2. Define its clean route, role/country scope and data contract.
3. Implement the model and service invariants.
4. Render the native `.ejs` page with an extensionless view name, real data and all empty/error states.
5. Add CSRF, validation, object authorization and audit where applicable.
6. Test desktop/mobile, keyboard, ownership and negative cases.
7. Remove its old localStorage/remote demo logic only after parity passes.

New screens not present in the supplied UI must reuse the same radii, palette,
button/input treatment, card density and responsive shell.
