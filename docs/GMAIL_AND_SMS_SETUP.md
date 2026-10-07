# Gmail and phone verification

## Gmail SMTP

Enable two-step verification on the Google account and create a Google App
Password for Classic Mart. Use that app password, not your ordinary Google login
password. A Google Workspace administrator may need to allow app passwords.
Keep the password out of Git and chat.

Set the following in your own runtime environment:

```dotenv
SIMPLE_LOGIN=false
MAIL_MODE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-mailbox@gmail.com
SMTP_PASSWORD=your-google-app-password
SMTP_FROM=Classic Mart <your-mailbox@gmail.com>
```

Port 587 with SMTP_SECURE=false is also supported; STARTTLS is mandatory.
Certificate verification and TLS 1.2 or newer are enforced on both modes.
SMTP_FROM should use that mailbox or a sender alias explicitly approved in Gmail.
Spaces in Gmail's displayed app password are removed by the Gmail adapter.

Run `npm run mail:verify` from the project root after configuring your environment.
This performs real SMTP authentication and TLS verification without sending an
email. Then test signup/email delivery to your own address. Authentication success
does not by itself prove inbox delivery. Gmail's quotas and spam handling still
apply; do not treat it as an unlimited transactional email service.

The application escapes user-controlled names in email HTML, disables file/URL
access in the SMTP message renderer, bounds connection timeouts, and hides raw
provider failures from user-facing messages. The local tests verify that a server
without STARTTLS cannot receive credentials or messages.

## eSMS Africa

The adapter follows the provider's published [SDK source](https://github.com/eSMS-Africa/esms-sdk-node)
and [registry documentation](https://www.npmjs.com/package/esms-sms).
It posts JSON to `https://sms.esmsafrica.io/api/messages/send` with bearer authentication.

```dotenv
SMS_MODE=esms
ESMS_API_KEY=<your live key from Developers → API Keys>
# Optional approved sender ID; leave empty to use the provider route default.
ESMS_SENDER_ID=
```

Production requires a live key (`esms_live_…`), never a test key. Keep keys in your
private environment settings, never Git or chat. Recipients must use international
format, such as `+256700000000`. Routing is detected by the provider.

`npm run sms:verify` checks authentication and available credit using GET `/balance`;
it sends no SMS. Then exercise signup with your own phone to confirm real receipt.
A queued/submitted message is accepted, not confirmed delivered. Failed, scheduled,
unknown or malformed responses invalidate the verification token. Requests have a
10-second timeout, prohibit redirects and do not automatically retry billed sends.

Do not use SIMPLE_LOGIN=true or development SMS log delivery to bypass phone
verification in production. The first phone-verification screen now explicitly
asks you to send a code, rather than suggesting one has already been sent.
A successful send is still required before entering the code.

Verification tokens are stored as hashes. They expire after ten minutes, permit
five failed guesses, and are claimed atomically so concurrent requests cannot
reuse them. Failed delivery invalidates the newly issued token and does not set
phoneVerifiedAt. Existing CSRF, session and resend/IP rate limits remain in place.

## Local verification result

All 353 repository tests pass, with zero skipped tests, when the local replica-set
verification database, development servers and Chromium are configured. That
includes a real local SMTP downgrade rejection test and concurrent MongoDB code
claims/guess limits. Gmail provider tests use an isolated transport fixture; the
workspace has no Gmail credentials, so live Gmail authentication or delivery has
not been verified. The eSMS adapter has additional protocol/security fixture tests. Actual eSMS delivery
requires the private account key, which is absent from this workspace.

## Signup policy

Signup requires email verification only, followed by onboarding. Phone verification
is optional and available from Dashboard → Profile. Unverified phones remain
unverified; this change does not treat email ownership as phone ownership.
The signup country-code selector uses active marketplace countries and their
configured phone prefixes. The server validates the selection and stores the
composed international number. A leading local trunk zero is removed; full
international input must match the selected prefix.

Production may use `SMS_MODE=disabled` (or leave SMS_MODE unset) until credentials
are ready. Optional phone verification then fails safely; it cannot mark a phone
verified. Production never falls back to development SMS log codes. Configuring
`SMS_MODE=esms` still requires a live key. Staff MFA requirements are unchanged.

## Verification review

Email verification confirms mailbox control, not legal identity. Optional phone
verification confirms number control and is not a replacement for privileged MFA.
Phone tokens are now bound to a hash of the number they were sent to; changing the
profile number cannot make an old code verify the new number. Existing unbound
phone tokens from earlier versions require a new send. This is deliberate.

The email verification page loads the same shared button styles as phone
verification. Resend buttons remain secondary actions, while verify buttons remain
primary actions; account switching has a consistent text-button style. All three
have visible keyboard focus, and secondary/account-switch targets are at least
44px high. Mobile browser checks verified both pages after real local signup.

## Phone lengths

Signup and profile changes share libphonenumber country-specific possible-length
validation and international normalization. National input uses the selected
country's trunk-prefix rules; international input must match the selected country.
The maximum international number length is 15 digits, but the country's valid
possible lengths are enforced before storage. Different countries and number
types may legitimately have different lengths. Formatting/length checks cannot
prove that a number is assigned, reachable, or owned by the user; SMS verification
still performs the ownership check.
