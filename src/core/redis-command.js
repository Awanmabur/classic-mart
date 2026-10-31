import { TimeoutError } from 'redis';

export const REDIS_COMMAND_TIMEOUT_MS = 5_000;

// node-redis removes its queue timeout once a command is written. Bound the
// reply as well, without retrying a mutation whose result is still uncertain.
export function requireRedisCommand(operation, { timeoutMs = REDIS_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const error = new TimeoutError('Redis command reply timed out.');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(() => operation(controller.signal)).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
    // Both handlers stay attached after a timeout: a late reply/rejection must
    // neither resume the request nor become an unhandled rejection.
  });
}
