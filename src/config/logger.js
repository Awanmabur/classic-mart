import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (env.isTest ? 'silent' : env.isProduction ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'token',
      'code',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.code',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'classic-mart',
    environment: env.nodeEnv,
  },
});
