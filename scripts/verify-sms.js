import { verifySmsConfiguration } from '../src/services/sms.js';
try {
  const result = await verifySmsConfiguration();
  if (!result.authenticated) throw new Error('SMS authentication was not verified.');
  console.log('Yoola authenticated the account request. Credit availability is unknown. No SMS was sent; handset delivery has not been verified.');
  process.exit(0);
} catch (error) {
  console.error(error.code || 'SMS_VERIFICATION_FAILED', error.expose ? error.message : 'SMS verification failed.');
  process.exit(1);
}
