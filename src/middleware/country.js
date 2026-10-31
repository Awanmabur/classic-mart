import { getCountries } from '../services/country.js';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { trustedProxyMatcher } from '../core/trusted-proxy.js';
import { parseCookies } from './request.js';

const code = value => typeof value === 'string' && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : '';

export function createCountryContext({ loadCountries = getCountries,
  trustedGeoProxyCidrs = env.geolocationTrustedProxyCidrs } = {}) {
  const trustGeoPeer = trustedProxyMatcher(trustedGeoProxyCidrs);
  return async function countryContext(request, response, next) {
    try {
      const countries = (await loadCountries()).filter(country => country.active !== false
        && (!env.isProduction || env.security.launchCountries.includes(country.code)));
      const available = new Map(countries.map(country => [country.code, country]));
      const cookies = parseCookies(request.get('cookie'));
      // A country header is useful only when the actual TCP peer is an explicitly
      // trusted edge that overwrites it. X-Forwarded-For never grants this trust.
      const edge = trustGeoPeer(request.socket?.remoteAddress) ? code(request.get('cf-ipcountry')) : '';
      const selected = [code(cookies.cm_country), code(request.user?.shoppingCountry), edge,
        env.security.launchCountries[0], 'UG'].find(value => available.has(value));
      request.country = available.get(selected) || countries[0];
      if (!request.country) throw new AppError('No launched market is currently available.', 503, 'COUNTRY_UNAVAILABLE');
      request.countrySource = selected === code(cookies.cm_country) ? 'selection'
        : selected === code(request.user?.shoppingCountry) ? 'preference' : selected === edge ? 'edge' : 'fallback';
      response.locals.country = request.country;
      response.locals.currency = request.country.currency;
      next();
    } catch (error) { next(error); }
  };
}

export const countryContext = createCountryContext();
