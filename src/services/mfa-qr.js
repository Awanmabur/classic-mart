import QRCode from 'qrcode';
import { AppError } from '../core/errors.js';
import { currentCustomerAccess } from './customer-access.js';
import { pendingMfaEnrollment } from './mfa.js';

/** Generate setup material locally for the current, still-authorized account. */
export async function pendingMfaQrCode(request) {
  const actor = await currentCustomerAccess(request);
  const enrollment = await pendingMfaEnrollment(actor._id);
  if (!enrollment) throw new AppError('Start authenticator setup from your security settings first.', 404, 'MFA_SETUP_NOT_PENDING');

  const image = await QRCode.toBuffer(enrollment.uri, {
    type: 'png', width: 256, margin: 4, errorCorrectionLevel: 'M',
    color: { dark: '#111827', light: '#ffffff' },
  });

  // An image is sensitive setup material. Do not deliver a QR generated before
  // device revocation, account changes or replacement/confirmation of its key.
  const currentEnrollment = await pendingMfaEnrollment(actor._id);
  await currentCustomerAccess(request);
  if (!currentEnrollment || currentEnrollment.uri !== enrollment.uri) {
    throw new AppError('Authenticator setup changed. Reload your security settings.', 409, 'MFA_ENROLLMENT_CHANGED');
  }
  return image;
}
