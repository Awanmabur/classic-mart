# Multi-factor authentication

Password & Security (`/account/security`) offers passkeys, authenticator apps and,
for eligible personal accounts, SMS. Sign-in still begins with the account's
password; the selected enrolled factor completes MFA. A factor never changes
the account's role, store membership or dashboard authorization.

## Methods and access

- **Passkey:** the device/browser verifies the user through a fingerprint, face,
  device PIN or supported security key. Classic Mart receives a signed WebAuthn
  assertion and stores the credential's public key, never biometric data or the
  private key. User verification is required. The device's available methods
  determine the actual prompt; a fingerprint sensor cannot be promised on every
  device.
- **Authenticator:** scan the existing QR code in a compatible authenticator and
  confirm its six-digit code. Encrypted TOTP secrets and single-use counters
  remain server-side.
- **SMS:** ordinary customers, sellers and promoters without managed platform
  staff access can choose SMS. One setup code confirms the saved phone and
  enables this factor. Delivery uses [Yoola](SMS.md); accepting a provider request
  does not verify the phone or complete MFA. SMS is weaker than a passkey and is
  subject to carrier delays, SIM takeover and provider availability.

Platform staff, Business purchasing and Delivery operations require a current
passkey or authenticator. Changing a payout destination or requesting a payout
also requires a strong factor, including for sellers and promoters. An SMS
session cannot borrow an authenticator/passkey enrolled on the same account to
gain this access. An authorized seller using SMS can continue ordinary store
operations, but must verify a strong method before those financial changes.

Recovery codes are shown once and stored only as hashes. Keep them privately
away from the device used to sign in. Each works once. Codes issued from SMS
enrollment retain its weaker assurance and cannot authorize staff access. Adding
the first strong method rotates the recovery set; the old codes stop working.
Legacy authenticator accounts without method metadata remain supported as
authenticator enrollments. New unmarked recovery codes do not gain legacy
assurance merely because an old ciphertext is present.

## Production configuration and rollout

1. Use Node.js 24 and install the locked dependencies with `npm ci`.
2. Configure one canonical HTTPS `BASE_URL` with the actual public hostname.
   Passkey relying-party identity and accepted origin derive from that value,
   never the incoming `Host` header. A hostname change affects credential
   compatibility; plan it before enrolling users. Local development may use
   `http://localhost` as the browser's permitted local secure context.
3. Keep `SIMPLE_LOGIN=false` and `PRIVILEGED_MFA_REQUIRED=true` in production.
   Use the existing independent session, token, data-encryption and security
   integrity secrets. No separate passkey secret or biometric API key is needed.
4. Configure `SMS_MODE=yoola` and `YOOLA_API_KEY` to offer real SMS. An optional
   approved `YOOLA_SENDER_ID` follows [the SMS setup](SMS.md). Development log
   codes are not production delivery. If SMS is unavailable, passkeys and
   authenticator apps remain usable.
5. Follow the [migration runbook](MIGRATION.md): verify a backup, review
   `npm run migrate:plan`, then run `npm run migrate:apply`. The existing
   apply command creates declared indexes for all exported models, including
   `MfaChallenge` and `PasskeyCredential`, without dropping unknown indexes.
   Verify this succeeds before accepting enrollments; production auto-indexing
   is not a substitute for this deployment step. No historical MFA enrollment
   is fabricated or automatically upgraded to passkey/SMS assurance.
6. Restart the web and worker processes with the same environment and build.
   Test enrollment, sign-out, sign-in, cancellation, recovery and revocation
   with accounts you control over the real HTTPS hostname. Confirm a real SMS
   reaches an owned handset before relying on it.

MongoDB must support transactions. SMS/passkey enrollment, revocation, challenge
consumption and their audit records commit together. Current user, device,
token version, password and ownership are rechecked around sensitive changes;
changing MFA revokes other sessions. Enrollment and proof challenges expire
after five minutes, bind to the issuing session and cannot replay. SMS allows
five incorrect guesses, a 60-second resend cooldown and shared account limits;
failed provider sends invalidate the issued challenge and are not automatically
retried.

## Account changes and recovery

Adding or removing methods requires the current password and an eligible
existing proof when MFA is already enabled. Weak SMS or SMS-origin recovery
cannot alter a strong method. A role requiring MFA cannot remove its last
eligible factor. Remove SMS in Password & Security before changing its bound
phone; add another required method first. This prevents a profile update from
silently transferring SMS security to an unverified number.

Existing operator recovery commands accept a current authenticator code or an
eligible single-use recovery code; they do not collect device biometric data or
attempt an interactive browser passkey prompt. Keep strong recovery codes for
accounts that need those commands. Operator authority, independent approvals
and audit requirements still apply.

Browser automation with a virtual authenticator verifies the WebAuthn signature
flow, origin binding and replay defenses. It does not establish compatibility
with every physical sensor. Synthetic Yoola responses establish adapter and
application behavior, not live account credit, carrier routing or delivery.
