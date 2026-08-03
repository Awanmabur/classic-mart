import { CountrySetting } from '../models/index.js';
import { env } from '../config/env.js';

const FALLBACK = Object.freeze({
  code: 'UG',
  name: 'Uganda',
  currency: 'UGX',
  locale: 'en-UG',
  timeZone: 'Africa/Kampala',
  phonePrefix: '+256',
  active: true,
});

let cache = new Map();
let cacheExpiresAt = 0;

async function refresh() {
  if (env.isTest) {
    cache = new Map([['UG', FALLBACK]]);
    cacheExpiresAt = Date.now() + 5 * 60_000;
    return;
  }
  const countries = await CountrySetting.find({ active: true }).lean();
  cache = new Map(
    countries.map((country) => [
      country.code,
      {
        code: country.code,
        name: country.name,
        currency: country.currency,
        locale: country.locale,
        timeZone: country.timeZone,
        phonePrefix: country.phonePrefix,
        active: country.active,
      },
    ]),
  );
  if (!cache.has('UG')) cache.set('UG', FALLBACK);
  cacheExpiresAt = Date.now() + 5 * 60_000;
}

export async function getCountry(code = 'UG') {
  if (Date.now() > cacheExpiresAt) await refresh();
  return cache.get(String(code).toUpperCase()) || cache.get('UG') || FALLBACK;
}

export async function getCountries() {
  if (Date.now() > cacheExpiresAt) await refresh();
  return [...cache.values()];
}

export function clearCountryCache() {
  cacheExpiresAt = 0;
}
