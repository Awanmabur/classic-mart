import { verifySmsConfiguration } from '../src/services/sms.js';
try {
  const result = await verifySmsConfiguration();
  console.log(`eSMS Africa authentication verified. Credit available: ${result.creditAvailable ? 'yes' : 'no'}. No SMS was sent.`);
  process.exit(0);
} catch (error) {
  console.error(error.code || 'SMS_VERIFICATION_FAILED', error.expose ? error.message : 'SMS verification failed.');
  process.exit(1);
}
