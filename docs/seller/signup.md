# Seller signup and enrolment

The existing Sell links open `/signup?role=seller`. Registration carries an
allowlisted account type in a hidden field and persists the seller role before
email verification. Profile setup preselects that role; successful setup and
later sign-in land in the approved seller workspace at `/seller/store`.
Local `SIMPLE_LOGIN` mode uses the same role-aware landing. There is no
dashboard role switcher.

Public header, footer and mobile account entries retain `/account/profile`.
This alias opens the customer's personal profile or the account's primary
role workspace. `/dashboard` also opens the account's primary workspace. Existing
sellers visiting bookmarked `/profile` or `/dashboard/profile` addresses
continue to `/seller/store`; the generic `/account/profile` alias does the
same. Customer `/account/profile` behaviour stays at its personal profile.
Explicit buyer order pages remain available to sellers, and shared account
security pages display the user's assigned role.

The legacy `/onboarding?role=seller` link keeps seller intent instead of
opening a completed customer's dashboard. Guests are directed to seller
signup, while existing customers reach deliberate seller enrolment. The
existing login page's Create Account link keeps that intent too. If an
existing customer must verify email or finish an incomplete profile first,
an allowlisted session continuation returns to seller enrolment. Opening
these pages does not change an account role; confirmation is still required.
The continuation is consumed when the verified form is reached, so choosing
Back to marketplace does not trap an incomplete customer in seller setup.
Ordinary `/signup` remains customer registration, including in development
simple-login mode. Seller registration starts through the existing Sell links.

Public account types are marketplace participation roles, not operational
staff privileges. Unknown or privileged account types fail validation. The old
untrusted `role` registration field cannot create staff or administrators.
Completed onboarding forms cannot change an established account's role.

Existing customers who choose Sell reach `/onboarding/seller` to explicitly
confirm seller enrolment. The page reuses the approved profile setup layout
with Seller fixed as the account type. The same user identity, contact details,
addresses, orders and security settings remain in place. Accounts previously
affected by the signup bug are not automatically relabelled from inferred data.

Enrolment requires CSRF, a fresh active account/session, verified email when
enforced, and the current profile revision. Managed staff or accounts with
platform-grant history cannot enrol themselves. Role/profile changes and the
mandatory audit commit in one transaction; account changes cause a conflict
instead of overwriting newer data. A retry after successful enrolment does not
rewrite the profile or emit another enrolment event.
Confirmation requests are limited to 20 per account every 15 minutes, across
source IPs.

A seller account does not publish products or bypass verification. Its new
store remains pending verification; independent store and product review still
govern publication. Sellers retain their own buyer/account permissions.

## Verification

`test/seller-signup-live.test.js` exercises the real application, isolated
MongoDB transactions, verification codes in the development mail sink, and
Chromium signup/profile forms on desktop and mobile. Provider delivery is a
separate integration check; this regression does not call Gmail or eSMS.
The tests also cover retained buyer orders and addresses, stale profiles,
concurrent confirmations, a real grant-provisioning race, revoked sessions and
audit rollback. Desktop/mobile checks include enrolment accessibility and
form/button geometry; simple-login coverage is in
`test/approved-dashboard.test.js`.

Before the later approved-palette restoration on 2026-10-09, the focused auth regression passed 20 tests with no
failures or skips, and the complete canonical suite passed 433 tests with no
failures or skips. Browser enrolment had no violations in the checked WCAG A/AA
rules at 390 and 1366 pixels. These checks do not certify the complete website.

`test/seller-account-entry-live.test.js` separately verifies actual public Sell
and Account links in desktop/mobile Chromium, persisted seller identity,
safe role-aware login destinations, existing-customer aliases, bookmarked
profile redirects, and seller intent across guest login, email verification,
and an actual MFA challenge using securely enrolled recovery codes.
It uses an isolated local MongoDB database and development delivery sinks.
These workflow checks do not certify provider delivery or accessibility.
On 2026-10-09 this public-entry regression passed 11 tests with no failures or
skips; the focused simple-login and shared-shell contracts passed 15 tests
with no failures or skips.
