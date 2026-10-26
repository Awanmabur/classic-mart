# Restore the approved palette — 26 October 2026

The user explicitly requested undoing the recent colour distortion. This
supersedes the broad recolouring introduced in `25d5d67`, despite the earlier
permission for minimal contrast corrections. The palette reference is the
approved appearance immediately before that commit (`cc6b7e1`). Do not silently
reintroduce the dark button labels or brown accents to clear accessibility CI.

Restore the original colour/filter declarations in the shared marketing,
storefront and catalogue stylesheets: white labels/icons on coloured controls,
original orange/red prices and accents, gold stars, and individual muted greys.
Remove the added black/brown MFA overrides so account security inherits the
approved dashboard controls. The separately approved darker seller setup labels
and submit control in `server-ui.css` are preserved.

A declaration-level comparison confirms that every shared palette declaration
matches the reference and that no non-palette declaration changed. Spacing,
image radii, animation, sharing, MFA security and the R2 startup recovery remain
intact. Public cache v34 ensures clients refresh the stylesheet correction.
Existing palette assertions now expect the approved white labels/icons; strict
WCAG tags and the empty-violation assertion are unchanged.

Verification: desktop and mobile palette checks both passed, covering home,
catalogue, login and seller signup. All 53 targeted cache, launch and storefront
regressions passed with no skips/failures. The original homepage palette fails
the unchanged Axe contrast check: its only violation rule is `color-contrast`
(209 affected nodes in the seeded fixture). Examples include white text on
`#ff6500` and that orange on white at 2.95:1, below 4.5:1 for their small text.
This restoration is not a WCAG contrast pass, and a previous green commit does
not establish a green result for it. No accessibility exception or CI bypass
has been added.
