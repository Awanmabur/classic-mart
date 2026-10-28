# Browser checks and the approved palette

CI preserves the approved storefront colours. Functional, security, keyboard,
dialog, focus, reflow and non-contrast accessibility failures block the release.
Colour-contrast findings are reported separately as design advisories.

Every Axe rule and browser assertion still executes. Contrast assertions remain
failed assertions in the original Playwright HTML/JUnit reports. Soft contrast
assertions let the rest of an interaction test finish, so a contrast finding
cannot hide a later broken button, focus return or dialog dismissal.

`npm run browser:ci` runs the complete browser suite and validates its report.
Only a contrast assertion with matching structured Axe evidence can be advisory.
An additional failed assertion, timeout, browser crash, global error, malformed
report or missing evidence fails the command. CI does not use a blanket
`continue-on-error` setting.

The job summary and `artifacts/ci-browser-summary.json` distinguish passing
tests, contrast-only advisory cases, skipped tests and blocking failures.
The existing browser diagnostic artifact retains HTML/JUnit results, screenshots
and traces. Raw Playwright JSON can contain server environment settings; it is
written only to a private temporary directory and removed after validation.

`npm run browser:check` and `npm run browser:a11y` remain strict: contrast
findings still make those commands fail. The comprehensive `release:check`
continues to include that strict browser check.

A successful CI run under this policy does **not** certify full WCAG AA
compliance. The contrast findings remain unresolved design limitations while
the exact approved palette is retained. No application stylesheet, colour,
layout or contrast threshold changes are part of this CI correction.
