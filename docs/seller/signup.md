# Seller signup and enrolment

The existing Sell links open `/signup?role=seller`. Registration carries an
allowlisted account type in a hidden field and persists the seller role before
email verification. Profile setup preselects that role; successful setup and
later sign-in land in the approved seller workspace at `/seller/store`.
Local `SIMPLE_LOGIN` mode uses the same role-aware landing. There is no
dashboard role switcher.

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

Verified on 2026-10-09: the focused auth regression passed 20 tests with no
failures or skips, and the complete canonical suite passed 433 tests with no
failures or skips. Browser enrolment had no violations in the checked WCAG A/AA
rules at 390 and 1366 pixels. These checks do not certify the complete website.
