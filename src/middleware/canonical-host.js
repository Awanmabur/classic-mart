import { env } from '../config/env.js';

// Only the www/apex alias of the configured origin is redirected. Arbitrary Host
// or X-Forwarded-Host values can never supply the redirect destination.
export function canonicalHost({ origin = env.baseUrl, enabled = env.isProduction } = {}) {
  const canonical = new URL(origin);
  const hostname = canonical.hostname.toLowerCase();
  const alias = hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
  return (request, response, next) => {
    if (!enabled || !['GET', 'HEAD'].includes(request.method)) return next();
    let host;
    try { host = new URL(`https://${request.get('host') || ''}`).hostname.toLowerCase(); } catch { return next(); }
    if (host !== alias) return next();
    const path = request.originalUrl || '/';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return next();
    response.set('Cache-Control', 'private, no-store');
    return response.redirect(308, canonical.origin + path);
  };
}
