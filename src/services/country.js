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
let refreshPromise = null;
let generation = 0;

async function refresh() {
  if (refreshPromise) return refreshPromise;
  const version = generation;
  const pending = (async () => {
    const countries = env.isTest ? [FALLBACK] : await CountrySetting.find({ active: true }).lean().exec();
    const updated = new Map(countries.map(country => [country.code, {
      code: country.code, name: country.name, currency: country.currency,
      locale: country.locale, timeZone: country.timeZone, phonePrefix: country.phonePrefix, active: country.active,
    }]));
    if (!updated.has('UG')) updated.set('UG', FALLBACK);
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
  return cache.get(String(code).toUpperCase()) || cache.get('UG') || FALLBACK;
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
