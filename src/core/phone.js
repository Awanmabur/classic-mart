import { parsePhoneNumberFromString, getCountryCallingCode } from 'libphonenumber-js/max';
import { AppError } from './errors.js';

// Country-specific possible lengths; actual ownership still needs an SMS code.
export function canonicalPhone(value, country) {
  const input = String(value || '').trim();
  if (!/^\+?[\d\s()-]+$/.test(input) || input.length > 30) {
    throw new AppError('Enter a valid phone number.', 422, 'INVALID_PHONE');
  }
  if (!country && !input.startsWith('+')) {
    throw new AppError('Include the country code in your phone number.', 422, 'INVALID_PHONE');
  }
  let phone;
  try { phone = parsePhoneNumberFromString(input, { defaultCountry: country, extract: false }); } catch {}
  if (!phone || !phone.isPossible() || phone.ext) {
    throw new AppError('The phone number is too short, too long, or has an invalid country code.', 422, 'INVALID_PHONE');
  }
  if (country && (phone.countryCallingCode !== getCountryCallingCode(country) || (phone.country && phone.country !== country))) {
    throw new AppError('Phone number does not match the selected country.', 422, 'INVALID_PHONE');
  }
  return phone.number;
}
