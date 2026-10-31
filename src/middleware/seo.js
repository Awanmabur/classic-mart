import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { getCountry } from '../services/country.js';
import { hasDuplicateQuery, isCountryPage, isPrivatePath, isPublicPath, pageSeo, SITE_URL } from '../services/seo.js';

// Crawler directives supplement existing authentication and authorization.
export async function seoContext(request, response, next) {
  try {
    const params = new URL(request.originalUrl, SITE_URL).searchParams;
    if (request.method === 'GET' && isCountryPage(request.path) && params.has('country')) {
      const values = params.getAll('country');
      const code = values[0];
      if (values.length !== 1 || !/^[A-Z]{2}$/.test(code) || (env.security.launchCountries.length && !env.security.launchCountries.includes(code))) throw new AppError('Country page not found.', 404, 'COUNTRY_NOT_FOUND');
      const country = await getCountry(code);
      if (country.code !== code) throw new AppError('Country page not found.', 404, 'COUNTRY_NOT_FOUND');
      request.country = country;
      request.countrySource = 'selection';
      response.locals.country = country;
      response.locals.currency = country.currency;
      // Existing storefront reads use this preference; keep HTML and API prices in the same market.
      response.cookie('cm_country', code, { httpOnly: true, sameSite: 'lax', secure: env.isProduction, path: '/', maxAge: 31_536_000_000 });
      response.set('Cache-Control', 'private, no-store');
    }
    response.locals.seo = pageSeo(request);
    if (!isPublicPath(request.path) || hasDuplicateQuery(request)) response.set('X-Robots-Tag', isPrivatePath(request.path) ? 'noindex, nofollow, noarchive' : 'noindex, follow');
    next();
  } catch (error) { response.set('X-Robots-Tag', 'noindex, nofollow'); next(error); }
}
