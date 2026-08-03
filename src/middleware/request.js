import { AppError } from '../core/errors.js';
import crypto from 'node:crypto';

export function requestContext(request, response, next) {
  const supplied = request.get('x-request-id');
  request.id =
    supplied && /^[a-zA-Z0-9_-]{8,80}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
  response.setHeader('x-request-id', request.id);
  response.locals.requestId = request.id;
  response.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  response.locals.currentPath = request.path;
  next();
}

export function noStore(_request, response, next) {
  response.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private',
  );
  response.setHeader('Pragma', 'no-cache');
  next();
}

export function sanitizeBody(request, _response, next) {
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  function assertSafeObject(value) {
    if (Array.isArray(value)) {
      value.forEach(assertSafeObject);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || forbidden.has(key)) {
        throw new AppError('Invalid request field.', 400, 'UNSAFE_INPUT_KEY');
      }
      assertSafeObject(child);
    }
  }
  try {
    // JSON/form bodies may contain legitimate nested domain objects, but never
    // MongoDB selector/path keys or prototype-pollution keys.
    assertSafeObject(request.body);
    // Public HTTP query parameters are scalar/repeated scalar values only.
    for (const [key, value] of Object.entries(request.query || {})) {
      if (key.startsWith('$') || key.includes('.') || forbidden.has(key)) {
        throw new AppError('Invalid query parameter.', 400, 'UNSAFE_INPUT_KEY');
      }
      const values = Array.isArray(value) ? value : [value];
      if (values.some((item) => item && typeof item === 'object')) {
        throw new AppError('Invalid query parameter.', 400, 'UNSAFE_INPUT_VALUE');
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map((part) => part.trim().split('='))
    .reduce((cookies, [name, ...rest]) => {
      if (name) {
        try {
          cookies[name] = decodeURIComponent(rest.join('='));
        } catch {
          // Ignore malformed attacker-controlled cookie values.
        }
      }
      return cookies;
    }, {});
}
