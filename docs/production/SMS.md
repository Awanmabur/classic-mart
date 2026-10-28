# Yoola SMS and phone country selection

Configure the server environment, then restart the web and worker processes:

```dotenv
SMS_MODE=yoola
YOOLA_API_KEY=
# Optional: your approved 1–11 letter/number sender; blank uses Yoola's default.
YOOLA_SENDER_ID=
```

Keep the actual key in the private runtime environment, never browser JavaScript,
Git or chat. Leave `YOOLA_SENDER_ID` empty to use the provider default, or set
your own sender only after Yoola approves it for the destination networks. It
must use 1–11 letters/numbers with no spaces or symbols. A sender name is not
proof of approval. Invalid configured names fail before a network request.
If `SMS_MODE` is omitted, a nonempty `YOOLA_API_KEY` selects Yoola. Production may
use `SMS_MODE=disabled` until the account is ready. Disabled or missing delivery
configuration cannot send or verify a phone. Development/test `SMS_MODE=log`
does not send an SMS and cannot run as production delivery. eSMS is removed.

## API reference and verification limits

The adapter was checked against Yoola's official public
[API documentation](https://yoolasms.com/api-integration),
[sender-ID guide](https://yoolasms.com/sender-id-guide) and
[OTP API documentation](https://yoolasms.com/sms-otp-verification-api) on
27 October 2026 (Africa/Kampala). The previous implementation used the owner's
reference application; the public provider documentation is now accessible.
Public documentation review and synthetic tests do not establish live account
authentication, credit, routing or handset delivery. No live Yoola key is present
in this verification environment, so the owner's exact rejection cannot be
independently diagnosed as a particular account problem here.

Sending uses HTTPS `POST https://yoolasms.com/api/v1/send` with JSON
`{api_key, phone, message}` and an optional approved `sender`. The stored E.164
number is sent as international digits without its leading `+`. The provider
page's overview mentions a bearer header, but all its published language examples
send `api_key` in the JSON body without one. This adapter follows those concrete
examples and does not add a second credential transmission or change auth mode
based on an unverified assumption. Only an explicit positive
status (`success`, `accepted`, `queued` or `ok`) for the successful `/send` request
counts as acceptance. A `message_id` is optional tracking metadata: an absent/null
ID is omitted, and a nonnegative safe integer is normalized to a string. A present
string must remain nonempty, bounded and free of control characters; malformed
present IDs are rejected. No replacement tracking ID is invented. Explicit errors,
known rejection codes, unknown status and malformed responses fail closed even
beside a positive status. Acceptance never sets `delivered: true` and does
not mark the user's phone verified; only a correct single-use OTP does that.

Run `npm run sms:verify` after supplying the key. It makes an HTTPS POST to
`/api/v1/balance` with only the API key and requires an explicit `success` or `ok`
status without an error. It sends no SMS. The balance value/unit schema has not
been independently established, so the probe reports credit availability as
unknown rather than inventing a numeric balance or asserting sufficient credit.
Successful account authentication is separate from actual delivery. Complete a
real phone-verification journey to a number you control and check receipt before
offering SMS-dependent identity verification. Check supported countries, sender route
and available credit in the Yoola account.

### Trace an accepted SMS that never arrives

Acceptance is not carrier delivery. A successful send now writes one bounded
`SMS request accepted by provider; handset delivery is not confirmed` event.
When Yoola supplies a usable reference, the event includes `providerMessageId`.
It does not include the recipient, OTP, API key or raw provider response. A
reference containing those private values is withheld. `receiptAvailable: false`
means there is no top-level tracking ID to query; use Yoola's own message history
for that attempt rather than inventing an ID or repeatedly sending codes.

On the server with its existing private Yoola configuration, query that exact
reference without sending another SMS:

```bash
npm run sms:verify -- --message-id PROVIDER_MESSAGE_ID
```

This uses the owner's pinned reference implementation's HTTPS
`POST /api/v1/delivery_report` with `{api_key, message_id}`. It interprets the
explicit `delivery_status`, `delivery` or `message_status` fields conservatively:
`delivered` is provider-reported delivery; `failed`, `undelivered` or `rejected`
is failure; `sent`, `pending`, `queued` or `processing` is still unconfirmed.
Missing, generic `success`, conflicting or unrecognized delivery fields remain
unknown. The top-level API `status` never establishes handset delivery.
Exit codes are 0 for provider-reported delivered, 1 for failure, 2 for invalid
command usage and 3 for pending/unknown. Errors use the existing safe SMS codes.
The command prints fixed classifications, never the raw response or private data.
It cannot change account verification or MFA state.

Endpoint/field evidence is the source of
[chariot-sms-test at e694237](https://github.com/Awanmabur/chariot-sms-test/blob/e694237edf03c2445c722f1f4b3bf5801a2740d2/src/lib/provider.js#L29),
not an independently verified live schema. A pending/failed/unknown report must
be resolved using the exact message's carrier result and rejection reason in
Yoola history/support. No specific cause such as credit, sender filtering,
destination or handset blocking can be inferred from an acceptance alone.

Redis connection resets and interrupted HTTP GET responses are a separate web
dependency issue. Redis session operations and shared rate counters have a
five-second reply deadline, including an established connection that stops
replying. They fail closed with the existing service-unavailable handling,
retain the shared reconnecting client and never retry an uncertain mutation.
An already-sent write can still settle after its deadline. Redis cannot prevent
carrier delivery after Yoola has accepted an SMS, so a Redis recovery log does
not explain or certify that message's handset delivery.

Requests prohibit redirects, expire after ten seconds and accept at most 16 KiB
of response data. API keys, OTPs, phone numbers and raw provider responses are not
printed by the adapter or verification command. Authentication, insufficient-credit,
sender, recipient/network and rate-limit failures receive distinct safe errors,
including known negative JSON responses returned with HTTP 200. Unknown
acknowledgements still fail closed. Timeout and connection failures have distinct
safe diagnostics. The provider's free-form message is inspected only to classify
a fixed category; its text, key, OTP, recipient and arbitrary error codes are never
copied into errors or logs. One failure log records only provider, operation, fixed
reason/error code and HTTP status. `npm run sms:verify` prints fixed operator
guidance and uses natural process exit after transport cleanup. Sends are not retried
automatically: a timeout can follow an accepted, billed SMS. A failed send
invalidates the newly issued OTP; it cannot mark a phone verified.

`sendMfaVerificationCode` uses the same transport and acceptance rules, with an
explicit sign-in/security message and a five-minute expiry matching the MFA
challenge. Provider acceptance is neither successful MFA nor confirmed delivery.
The account challenge must still be checked and atomically consumed by the
authentication flow; the SMS adapter never enables an MFA factor itself.

On 28 October 2026, browser regressions reproduced a false rejection caused by
requiring every positive acknowledgement to include a string tracking ID. That
exception consumed the pending OTP even though the provider had acknowledged
the send. The adapter now separates tracking metadata from acceptance; OTP
ownership, expiry, attempt limits, cooldown and atomic single use are unchanged.
These tests use a fake billed provider boundary with the real application,
MongoDB and Chromium. They establish application behaviour, not live handset
delivery. The official documentation endpoint was unavailable in this cloud
session (CONNECT 403), and no private Yoola key was injected here; do not describe
this correction as independently verified against the owner's live account.

## Signup and phone controls

Email verification is required for ordinary signup. Phone verification is a
separate optional step for ordinary shoppers; privileged staff still require the
verified identity and strong MFA checks enforced by their workspace. SMS MFA
does not replace the [passkey or authenticator requirement](MFA.md) for staff.

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
