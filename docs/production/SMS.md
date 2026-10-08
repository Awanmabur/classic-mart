# eSMS Africa and phone country selection

Phone dropdowns use `libphonenumber-js` country/calling-code metadata and Node's
international country names. The list is generated once, with no hand-written
country table or remote country request during signup. Market country settings
remain separate from a person's phone country. Signup and seller support contacts
validate country-specific possible lengths and persist E.164 numbers. Country
codes are shown first in the approved rounded dropdown so they stay visible on
small screens.

The only external SMS adapter is eSMS Africa. Deployment examples and the Render
blueprint use it. Configure secrets in the server environment, never in frontend
JavaScript or Git:

```dotenv
SMS_MODE=esms
ESMS_API_KEY=<live key from eSMS Africa>
ESMS_SENDER_ID=<optional approved sender ID>
```

If `SMS_MODE` is omitted, configuring `ESMS_API_KEY` automatically selects eSMS.
An explicit `SMS_MODE=log` remains a development-only sink; it does not send SMS
and the phone page now states that clearly. Production refuses test keys and log
mode. Phone verification remains optional for ordinary shopping and is requested
separately after email verification.

Restart the web process after changing environment settings. Run `npm run
sms:verify` to check API authentication and available credit without sending a
message. An accepted message is not a delivery receipt. The phone page therefore
reports acceptance for sending rather than confirmed delivery. Use a live key,
sufficient balance and an approved sender or the provider's default route sender.
The dropdown includes all supported phone countries; actual SMS destinations
depend on the routes enabled on the eSMS account.

Authentication, insufficient-credit and rate-limit failures have distinct safe
errors. Provider bodies, credentials and codes are not exposed in error messages.
Malformed/rejected responses fail closed; failed sends invalidate their OTP.
Sends are not automatically retried because a timeout can follow a billed send.
The existing OTP expiry, guess limits, resend cooldown, single-use checks and CSRF
protections remain active.

On 2026-10-08, this cloud environment had no eSMS API key. The configuration probe
returned `SMS_NOT_CONFIGURED`; no real SMS was sent. Adapter tests check the
provider's documented protocol and error behavior. Browser checks exercise
country selection and visible calling codes at desktop and mobile sizes. Live
phone delivery must still be verified after credentials are configured.
