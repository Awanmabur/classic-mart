import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../core/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { requestErrorLogged } from './http-logging.js';

export function notFound(request, _response, next) {
  next(new AppError(`Page not found: ${request.path}`, 404, 'NOT_FOUND'));
}

export function errorHandler(error, request, response, _next) {
  response.set('Cache-Control', 'private, no-store');
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  let normalized = error;
  if (error instanceof ZodError) {
    normalized = new AppError(
      error.issues[0]?.message || 'Check the information and try again.',
      422,
      'VALIDATION_ERROR',
      error.flatten(),
    );
  }
  if (error instanceof multer.MulterError) {
    normalized = new AppError(
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 8 MB or smaller.'
        : 'The upload could not be accepted.',
      422,
      'UPLOAD_INVALID',
    );
  }
  if (error?.code === 11000) {
    normalized = new AppError(
      'That record already exists.',
      409,
      'DUPLICATE_RECORD',
    );
  }
  if (!(normalized instanceof AppError)) {
    normalized = new AppError(
      'Something went wrong. Try again.',
      500,
      'INTERNAL_ERROR',
    );
  }

  const status = normalized.status || 500;
  if (status >= 500) {
    request[requestErrorLogged] = true;
    logger.error(
      {
        req: request,
        statusCode: status,
        errorCode: normalized.code,
        err: error,
      },
      'Request failed',
    );
  }

  if (request.path.startsWith('/api/') || request.accepts(['html', 'json']) === 'json') {
    return response.status(status).json({
      error: {
        code: normalized.code,
        message:
          normalized.expose || !env.isProduction
            ? normalized.message
            : 'Something went wrong.',
        requestId: request.id,
      },
    });
  }

  return response.status(status).render('error', {
    user: request.user || null,
    status,
    code: normalized.code,
    message:
      normalized.expose || !env.isProduction
        ? normalized.message
        : 'Something went wrong.',
  });
}
