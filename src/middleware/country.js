import { getCountry } from '../services/country.js';
import { parseCookies } from './request.js';

export async function countryContext(request, response, next) {
  try {
    const cookies = parseCookies(request.get('cookie'));
    const requested =
      request.user?.country ||
      cookies.cm_country ||
      request.get('cf-ipcountry') ||
      'UG';
    request.country = await getCountry(requested);
    response.locals.country = request.country;
    response.locals.currency = request.user?.currency || request.country.currency;
    next();
  } catch (error) {
    next(error);
  }
}
