import { verifyMailConfiguration } from '../src/services/mail.js';
try {
  await verifyMailConfiguration();
  console.log('SMTP authentication and TLS verified. No message was sent.');
  process.exit(0);
} catch(error) {
  console.error(error.code || 'MAIL_VERIFICATION_FAILED', error.expose ? error.message : 'SMTP verification failed.');
  process.exit(1);
}
