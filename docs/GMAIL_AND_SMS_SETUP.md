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

## eSMS Africa: integration awaiting the documented API contract

This checkpoint still supports Twilio and development log delivery; it does not
claim eSMS Africa support. An eSMS Africa key is not a Twilio authentication token.
Before implementing the provider adapter, supply its official API documentation
URL or credential-free request and success/error response examples. The provider
endpoint, authentication format, phone-number requirements, sender ID and response
contract must be known. An HTTP success alone must not be treated as accepted SMS
if the provider reports an error in its body.

Do not use SIMPLE_LOGIN=true or development SMS log delivery to bypass phone
verification in production. The first phone-verification screen now explicitly
asks you to send a code, rather than suggesting one has already been sent.
A successful send is still required before entering the code.

Verification tokens are stored as hashes. They expire after ten minutes, permit
five failed guesses, and are claimed atomically so concurrent requests cannot
reuse them. Failed delivery invalidates the newly issued token and does not set
phoneVerifiedAt. Existing CSRF, session and resend/IP rate limits remain in place.

## Local verification result

All 349 repository tests pass, with zero skipped tests, when the local replica-set
verification database, development servers and Chromium are configured. That
includes a real local SMTP downgrade rejection test and concurrent MongoDB code
claims/guess limits. Gmail provider tests use an isolated transport fixture; the
workspace has no Gmail credentials, so live Gmail authentication or delivery has
not been verified. eSMS Africa delivery has not been tested or implemented yet.
