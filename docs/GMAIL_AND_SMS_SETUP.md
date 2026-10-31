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

## Yoola SMS

Use the complete [SMS setup and verification limits](production/SMS.md). Configure:

```dotenv
SMS_MODE=yoola
YOOLA_API_KEY=
```

Restart the web and worker processes after setting the private key. The adapter
uses the provider's default sender and has no sender-ID setting. It matches the
owner's [existing Yoola integration](https://github.com/Awanmabur/chariot-sms-test/blob/e694237edf03c2445c722f1f4b3bf5801a2740d2/src/lib/provider.js),
not an independently verified official specification. eSMS is removed.

`npm run sms:verify` checks an explicit positive authentication response from
POST `/api/v1/balance` without sending SMS. Credit availability remains unknown
because the balance schema is not independently established. The command never
claims handset delivery. Test a real phone-verification code with your own number
and check Yoola's delivery dashboard before relying on the service. No real Yoola
key was available for cloud verification; fixture tests establish only the local
request/response and failure handling.

Sending uses POST `/api/v1/send` with JSON `api_key`, international `phone` digits
and `message`. A positive status and usable message ID establish provider
acceptance, which is separate from handset receipt and number ownership. Requests
use a ten-second timeout, prohibit redirects, bound responses and never retry a
potentially billed send automatically. Provider failures and rejected responses
invalidate the newly issued OTP without exposing credentials, codes or raw bodies.

## Signup policy

Signup requires email verification followed by onboarding. Phone verification is
a separate optional step for ordinary customers and remains available from the
profile. Email ownership does not imply phone ownership. Privileged staff still
require verified identity and authenticator enrollment. Never use SIMPLE_LOGIN
or development log delivery to bypass production verification.

Phone selectors derive countries and calling codes from `libphonenumber-js`
metadata. The server validates the selected country's possible lengths and saves
a normalized E.164 number. Production may use `SMS_MODE=disabled` until the Yoola
account is configured; optional verification then fails safely and no number is
marked verified. `SMS_MODE=yoola` requires `YOOLA_API_KEY`. Development log codes
cannot be used as production delivery.

## Local verification scope

The Gmail checks include isolated SMTP fixtures and real local TLS downgrade
rejection. They do not establish Gmail inbox delivery without configured account
credentials. Yoola protocol/security fixtures use the reference contract above;
they do not establish a live provider account or carrier delivery. Current full
project results and separate launch blockers are recorded in
[the latest recovery verification](audits/2026-10-25-verification.md).

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
