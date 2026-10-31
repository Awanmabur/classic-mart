import { CountrySetting } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

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
let refreshPromise = null;
let generation = 0;

async function refresh() {
  if (refreshPromise) return refreshPromise;
  const version = generation;
  const pending = (async () => {
    const countries = env.isTest ? [FALLBACK] : await CountrySetting.find({ active: true }).lean().exec();
    const eligible = env.isProduction ? countries.filter(country => env.security.launchCountries.includes(country.code)) : countries;
    const updated = new Map(eligible.map(country => [country.code, {
      code: country.code, name: country.name, currency: country.currency,
      locale: country.locale, timeZone: country.timeZone, phonePrefix: country.phonePrefix, active: country.active,
    }]));
    if (!env.isProduction && !updated.has('UG')) updated.set('UG', FALLBACK);
    if (generation === version) { cache = updated; cacheExpiresAt = Date.now() + 5 * 60_000; }
  })();
  refreshPromise = pending;
  try { await pending; } finally { if (refreshPromise === pending) refreshPromise = null; }
}
async function ensureCache() {
  while (Date.now() >= cacheExpiresAt) await refresh();
}

export async function getCountry(code = 'UG') {
  await ensureCache();
  const country = cache.get(String(code).toUpperCase()) || cache.get(env.security.launchCountries[0]) || cache.values().next().value;
  if (!country) throw new AppError('No launched market is currently available.', 503, 'COUNTRY_UNAVAILABLE');
  return country;
}

export async function getCountries() {
  await ensureCache();
  return [...cache.values()];
}

export function clearCountryCache() {
  generation++;
  refreshPromise = null;
  cacheExpiresAt = 0;
}
