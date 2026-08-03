import { hasPermission, roleLabel } from '../core/roles.js';

export function viewLocals(request, response, next) {
  const flash = request.session?.flash;
  if (flash) delete request.session.flash;
  Object.assign(response.locals, {
    flash,
    hasPermission,
    roleLabel,
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
