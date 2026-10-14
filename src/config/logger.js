import pino from 'pino';
import { env } from './env.js';
import { getTraceContext } from '../core/trace.js';
import { safeLogFields } from '../core/logging.js';

export function createLogger({ production = env.isProduction, level = process.env.LOG_LEVEL || (env.isTest ? 'silent' : 'info') } = {}, destination) {
  return pino({
    level,
    formatters: {
      log: (fields) => safeLogFields(fields, { production }),
    },
    hooks: {
      logMethod(args, method) {
        // Pino otherwise promotes Error.message to msg before serialization.
        if (args.length === 1 && (args[0] instanceof Error || args[0]?.err instanceof Error || args[0]?.error instanceof Error)) {
          args.push('Error diagnostic');
        }
        method.apply(this, args);
      },
    },
    // Pino's default err serializer copies enumerable Error properties. The
    // formatter already serializes Errors using an explicit privacy whitelist.
    serializers: { err: (error) => error },
    base: {
      service: 'classic-mart',
      environment: env.nodeEnv,
    },
    mixin() {
      const trace = getTraceContext();
      return trace ? { traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentSpanId || undefined } : {};
    },
  }, destination);
}

export const logger = createLogger();
