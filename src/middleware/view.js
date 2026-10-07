import { hasPermission, roleLabel } from '../core/roles.js';
import { env } from '../config/env.js';

const SOCIAL_CHANNELS = Object.freeze([
  ['facebook', 'Facebook', '/assets/icons/facebook-f.svg'],
  ['x', 'X', '/assets/icons/x-twitter.svg'],
  ['instagram', 'Instagram', '/assets/icons/instagram.svg'],
  ['youtube', 'YouTube', '/assets/icons/youtube.svg'],
  ['pinterest', 'Pinterest', '/assets/icons/pinterest.svg'],
]);

function configuredSocialLinks() {
  return SOCIAL_CHANNELS.flatMap(([key, label, icon]) => {
    const value = String(env.social?.[key] || '').trim();
    if (!value) return [];
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? [{ label, icon, url: url.toString() }] : [];
    } catch {
      return [];
    }
  });
}

const socialLinks = Object.freeze(configuredSocialLinks());

export function viewLocals(request, response, next) {
  const flash = request.session?.flash;
  if (flash) delete request.session.flash;
  Object.assign(response.locals, {
    flash,
    hasPermission,
    roleLabel,
    socialLinks,
    currentPath: request.originalUrl || request.url || '/',
    deliveryCity: String(request.session?.deliveryCity || ''),
    deliveryLocation: request.session?.deliveryCity ? `${request.session.deliveryCity}, ${request.country?.name || ''}`.replace(/,\s*$/, '') : request.country?.name,
    formatMoney(value, currency = request.user?.currency || request.country?.currency || 'UGX') {
      const code = String(currency || 'UGX').toUpperCase();
      const minor = Number(value || 0);
      const zeroDecimal = new Set(['UGX', 'RWF', 'JPY', 'KRW']);
      const major = zeroDecimal.has(code) ? minor : minor / 100;
      try {
        return new Intl.NumberFormat(request.user?.locale || request.country?.locale || 'en-UG', {
          style: 'currency', currency: code, maximumFractionDigits: zeroDecimal.has(code) ? 0 : 2,
        }).format(major);
      } catch {
        return `${code} ${major.toLocaleString('en-US', { maximumFractionDigits: zeroDecimal.has(code) ? 0 : 2 })}`;
      }
    },
    formatDate(value) {
      if (!value) return 'Not available';
      return new Intl.DateTimeFormat(
        request.user?.locale || request.country?.locale || 'en-UG',
        { dateStyle: 'medium', timeStyle: 'short' },
      ).format(new Date(value));
    },
  });
  next();
}

export function setFlash(request, type, message, details) {
  request.session.flash = { type, message, details };
}
