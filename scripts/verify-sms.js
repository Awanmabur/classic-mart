import { getSmsDeliveryReport, verifySmsConfiguration } from '../src/services/sms.js';
const failureHelp = Object.freeze({
  SMS_NOT_CONFIGURED: 'Set SMS_MODE=yoola and YOOLA_API_KEY in the private environment, then restart.',
  SMS_SENDER_NOT_CONFIGURED: 'Set YOOLA_SENDER_ID to your approved 1–11 letter/number sender, or leave it empty for the provider default.',
  SMS_AUTH_FAILED: 'Yoola rejected authentication or account permissions. Check the API key and account access.',
  SMS_CREDIT_REQUIRED: 'Yoola reported insufficient SMS credit. Check the account balance.',
  SMS_SENDER_REJECTED: 'Yoola rejected the sender. Check that the configured sender is approved for the destination network.',
  SMS_RECIPIENT_REJECTED: 'Yoola rejected the recipient route. Check the country code and supported network.',
  SMS_PROVIDER_RATE_LIMITED: 'Yoola temporarily rate limited this account. Wait before trying again.',
  SMS_REQUEST_TIMEOUT: 'The Yoola request timed out. No authentication or credit result was confirmed.',
  SMS_NETWORK_FAILED: 'The Yoola endpoint could not be reached. Check outbound HTTPS connectivity and DNS.',
  SMS_DELIVERY_FAILED: 'Yoola did not return a confirmed positive response. Check the account and provider status.',
  SMS_INVALID_RECEIPT: 'Provide the provider message reference from the SMS acknowledgement log or Yoola history.',
});
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--message-id' || !args[1])) {
    console.error('Usage: npm run sms:verify -- --message-id PROVIDER_MESSAGE_ID (read-only; sends no SMS).');
    process.exitCode = 2;
  } else if (args.length) {
    const { state } = await getSmsDeliveryReport(args[1]);
    const descriptions = {
      delivered: 'Yoola reports delivered. Confirm handset receipt; account verification still requires the correct code.',
      failed: 'Yoola reports delivery failure. Ask Yoola for the carrier rejection reason for this message reference.',
      pending: 'Yoola has not confirmed handset delivery. Do not repeatedly request new codes.',
      unknown: 'Yoola did not return a recognized delivery state. Check its message history or support.',
    };
    console.log(`Yoola delivery report: ${state}. ${descriptions[state]} No SMS was sent by this check.`);
    process.exitCode = state === 'delivered' ? 0 : state === 'failed' ? 1 : 3;
  } else {
    const result = await verifySmsConfiguration();
    if (!result.authenticated) throw new Error('SMS authentication was not verified.');
    console.log('Yoola authenticated the account request. Credit availability is unknown. No SMS was sent; handset delivery has not been verified.');
    process.exitCode = 0;
  }
} catch (error) {
  const code = Object.hasOwn(failureHelp, error?.code) ? error.code : 'SMS_VERIFICATION_FAILED';
  console.error(code, failureHelp[code] || 'SMS verification failed.');
  process.exitCode = 1;
}
