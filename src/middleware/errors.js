import { ZodError } from 'zod';
import multer from 'multer';
import mongoose from 'mongoose';
import { ClientClosedError, ClientOfflineError, ConnectionTimeoutError, RootNodesUnavailableError, SocketClosedUnexpectedlyError, SocketTimeoutError, TimeoutError } from 'redis';
import { AppError } from '../core/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { requestErrorLogged } from './http-logging.js';

const parserErrors = Object.freeze({
  'entity.parse.failed': [400, 'REQUEST_BODY_INVALID', 'The request body is invalid.'],
  'entity.too.large': [413, 'REQUEST_BODY_TOO_LARGE', 'The request is too large.'],
  'parameters.too.many': [413, 'REQUEST_BODY_TOO_LARGE', 'The request contains too many form fields.'],
  'encoding.unsupported': [415, 'REQUEST_ENCODING_UNSUPPORTED', 'The request encoding is not supported.'],
  'charset.unsupported': [415, 'REQUEST_ENCODING_UNSUPPORTED', 'The request character set is not supported.'],
  'request.aborted': [400, 'REQUEST_BODY_INVALID', 'The request was interrupted.'],
  'request.size.invalid': [400, 'REQUEST_BODY_INVALID', 'The request size is invalid.'],
});

function databaseUnavailable(error) {
  return error instanceof mongoose.mongo.MongoServerSelectionError
    || error instanceof mongoose.mongo.MongoNetworkError
    || error instanceof mongoose.Error.MongooseServerSelectionError;
}

const sharedStoreErrorTypes = [ClientClosedError, ClientOfflineError, ConnectionTimeoutError,
  RootNodesUnavailableError, SocketClosedUnexpectedlyError, SocketTimeoutError, TimeoutError];
function sharedStoreUnavailable(error) {
  return sharedStoreErrorTypes.some(Type => error instanceof Type)
    || error instanceof Error && error.code === 'RATE_LIMIT_STORE_UNAVAILABLE';
}

function logRequestFailure(error, request, status, code) {
  if (request[requestErrorLogged]) return;
  request[requestErrorLogged] = true;
  logger.error({ req: request, statusCode: status, errorCode: code, err: error }, 'Request failed');
}

export function notFound(request, _response, next) {
  next(new AppError(`Page not found: ${request.path}`, 404, 'NOT_FOUND'));
}

export function errorHandler(error, request, response, _next) {
  // CSV/media responses may fail after their headers were sent. Express must
  // terminate that response; attempting to render a second page throws again.
  // Close it here after our sanitized diagnostic so the default handler cannot
  // print the original error/stack (which can contain provider/DB credentials).
  if (response.headersSent) {
    logRequestFailure(error, request, 500, 'RESPONSE_INTERRUPTED');
    response.destroy();
    return;
  }
  response.set('Cache-Control', 'private, no-store');
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  let normalized = error;
  const parserError = error instanceof Error && Object.hasOwn(parserErrors, error.type) ? parserErrors[error.type] : null;
  if (parserError && error.status === parserError[0]) normalized = new AppError(parserError[2], parserError[0], parserError[1]);
  if (databaseUnavailable(error)) {
    normalized = new AppError('The service cannot reach its database. Please try again shortly.', 503, 'DATABASE_UNAVAILABLE');
    normalized.expose = true;
    response.set('Retry-After', '30');
  } else if (sharedStoreUnavailable(error)) {
    normalized = new AppError('The service is temporarily unavailable. Please try again shortly.', 503, 'SERVICE_UNAVAILABLE');
    normalized.expose = true;
    response.set('Retry-After', '30');
  }
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
  if (status >= 500) logRequestFailure(error, request, status, normalized.code);

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
