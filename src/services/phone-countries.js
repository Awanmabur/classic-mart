import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';

const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = Object.freeze(getCountries().map(code => Object.freeze({
  code, name: names.of(code), phonePrefix: `+${getCountryCallingCode(code)}`,
})).sort((a, b) => a.name.localeCompare(b.name, 'en')));

export function getPhoneCountries() { return countries; }
