import { logger } from '../config/logger.js';
import { safeRequest } from '../core/logging.js';

export const requestErrorLogged = Symbol('requestErrorLogged');
const QUIET_PATH = /^(?:\/health(?:\/|$)|\/assets(?:\/|$)|\/approved-dashboard(?:\/|$)|\/[^/]+\.(?:css|js|ico|png|webmanifest|woff2?)$)/;

export function createHttpLogging({ log = logger, accessLogs = process.env.LOG_HTTP_ACCESS === 'true' } = {}) {
  return function httpLogging(request, response, next) {
    const started = performance.now();
    let finished = false;
    response.once('finish', () => {
      finished = true;
      if (request[requestErrorLogged]) return;
      const statusCode = response.statusCode;
      if (statusCode < 500 && (!accessLogs || (statusCode < 400 && QUIET_PATH.test(request.path || '')))) return;
      const { id: requestId, method, route } = safeRequest(request);
      const fields = { requestId, method, route, statusCode, durationMs: Math.round(performance.now() - started) };
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      log[level](fields, statusCode >= 500 ? 'HTTP request failed' : 'HTTP request completed');
    });
    response.once('close', () => {
      if (finished || response.writableFinished || request[requestErrorLogged]) return;
      const { id: requestId, method, route } = safeRequest(request);
      // Navigating away or replacing a product preview commonly cancels its
      // public image downloads. Keep those diagnostics available at debug;
      // failed responses and interrupted operational pages remain visible.
      const expectedMediaCancellation = ['GET', 'HEAD'].includes(method)
        && route === '/media/catalogue/:publicId' && response.statusCode < 400;
      log[expectedMediaCancellation ? 'debug' : 'warn'](
        { requestId, method, route, durationMs: Math.round(performance.now() - started) },
        expectedMediaCancellation ? 'Catalogue image download cancelled' : 'HTTP response interrupted',
      );
    });
    next();
  };
}

export const httpLogging = createHttpLogging();
