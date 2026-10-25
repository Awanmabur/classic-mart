# Yoola SMS and phone country selection

Configure the server environment, then restart the web and worker processes:

```dotenv
SMS_MODE=yoola
YOOLA_API_KEY=
```

Keep the actual key in the private runtime environment, never browser JavaScript,
Git or chat. The provider's default sender is used; there is no sender-ID setting.
If `SMS_MODE` is omitted, a nonempty `YOOLA_API_KEY` selects Yoola. Production may
use `SMS_MODE=disabled` until the account is ready. Disabled or missing delivery
configuration cannot send or verify a phone. Development/test `SMS_MODE=log`
does not send an SMS and cannot run as production delivery. eSMS is removed.

## API reference and verification limits

This adapter matches the owner's existing integration in
[Awanmabur/chariot-sms-test, commit e694237](https://github.com/Awanmabur/chariot-sms-test/blob/e694237edf03c2445c722f1f4b3bf5801a2740d2/src/lib/provider.js)
and its
[protocol fixture](https://github.com/Awanmabur/chariot-sms-test/blob/e694237edf03c2445c722f1f4b3bf5801a2740d2/tests/provider.test.js).
These are reference application sources, not an independently verified official
provider specification. Yoola's public documentation could not be retrieved in
this environment. No live Yoola authentication or handset delivery is established
by the local fixture tests.

Sending uses HTTPS `POST https://yoolasms.com/api/v1/send` with JSON
`{api_key, phone, message}`. The stored E.164 number is sent as international digits
without its leading `+`. There is no bearer header. Only an explicit positive
status (`success`, `accepted`, `queued` or `ok`) together with a nonempty, bounded
`message_id` counts as acceptance. Errors, unknown status, missing identifiers and
malformed responses fail closed. Acceptance never sets `delivered: true` and does
not mark the user's phone verified; only a correct single-use OTP does that.

Run `npm run sms:verify` after supplying the key. It makes an HTTPS POST to
`/api/v1/balance` with only the API key and requires an explicit `success` or `ok`
status without an error. It sends no SMS. The balance value/unit schema has not
been independently established, so the probe reports credit availability as
unknown rather than inventing a numeric balance or asserting sufficient credit.
Successful account authentication is separate from actual delivery. Complete a
real phone-verification journey to a number you control and check receipt before
enabling SMS-dependent staff onboarding. Check supported countries, sender route
and available credit in the Yoola account.

Requests prohibit redirects, expire after ten seconds and accept at most 16 KiB
of response data. API keys, OTPs, phone numbers and raw provider responses are not
printed by the adapter or verification command. Authentication, insufficient-credit
and rate-limit HTTP failures receive distinct safe errors. Sends are not retried
automatically: a timeout can follow an accepted, billed SMS. A failed send
invalidates the newly issued OTP; it cannot mark a phone verified.

## Signup and phone controls

Email verification is required for ordinary signup. Phone verification is a
separate optional step for ordinary shoppers; privileged staff still require the
verified identity and authenticator checks enforced by their workspace.

Phone dropdowns use `libphonenumber-js` country/calling-code metadata and Node's
international country names, with no handwritten country table or remote request
during signup. Market settings remain separate from the person's phone country.
The closed rounded native selector shows only a calling code such as `+256`;
its opened list shows alphabetical country names and calling codes. Keyboard,
touch, reset and back navigation keep the visible calling code synchronized.
Country-specific possible lengths are checked before saving a normalized E.164
number, whose maximum is 15 digits. Format and length do not establish ownership
or a working carrier route; the SMS challenge establishes number control.

OTP values are hashed, expire after ten minutes, allow five incorrect guesses,
and are atomically claimed once. Tokens bind to the phone number they were sent
to. Changing the phone invalidates the old token's usefulness. CSRF, session,
resend cooldown, user/IP limits and privileged MFA remain enabled.
