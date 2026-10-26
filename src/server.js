import http from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { disconnectRedis, getRedisClient } from './config/redis.js';
import { ensureStorageReady } from './config/storage.js';

let server;
let shuttingDown = false;
let shutdownExitCode = 0;
let startupPromise;
let shutdownPromise;
const startupController = new AbortController();

async function start() {
  await ensureStorageReady({ signal: startupController.signal });
  if (shuttingDown) return;
  await connectDatabase();
  if (shuttingDown) return;
  const redis = await getRedisClient();
  if (shuttingDown) return;
  const app = createApp(redis);
  server = http.createServer(
    {
      requestTimeout: 15_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxRequestsPerSocket: 1_000,
    },
    app,
  );
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(env.port, '0.0.0.0', () => {
      server.off('error', failed);
      resolve();
    });
  });
  if (!shuttingDown) logger.info({ port: env.port }, 'Classic Mart ready');
}

function shutdown(signal, exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  process.exitCode = shutdownExitCode;
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  startupController.abort();
  logger.info({ signal }, 'Shutting down');

  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  // Keep the deadline while sockets and aborted fetch handles drain, but do
  // not keep an otherwise clean process alive merely to wait for this timer.
  forceTimer.unref();

  shutdownPromise = (async () => {
    // A signal during storage/DB initialization must not disconnect resources
    // which the still-pending startup operation can subsequently reopen.
    await startupPromise;
    if (server) {
      try {
        await new Promise((resolve, reject) => server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        }));
      } catch (error) {
        shutdownExitCode = 1;
        logger.error({ err: error }, 'HTTP shutdown failed');
      }
    }
    const results = await Promise.allSettled([
      Promise.resolve().then(disconnectRedis),
      Promise.resolve().then(disconnectDatabase),
    ]);
    for (const result of results) if (result.status === 'rejected') {
      shutdownExitCode = 1;
      logger.error({ err: result.reason }, 'Shutdown cleanup failed');
    }
    // Let Node drain pending native close callbacks instead of exiting while
    // an aborted startup request is still tearing its sockets down.
    process.exitCode = shutdownExitCode;
  })().catch(error => {
    shutdownExitCode = 1;
    process.exitCode = 1;
    logger.error({ err: error }, 'Shutdown failed');
  });
  return shutdownPromise;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'Unhandled rejection');
  shutdown('unhandledRejection', 1);
});

startupPromise = start().catch((error) => {
  if (shuttingDown && startupController.signal.aborted
    && (error === startupController.signal.reason || error?.name === 'AbortError')) return;
  logger.fatal({ err: error }, 'Startup failed');
  // Do not return/await shutdown here: it waits for startupPromise to settle.
  void shutdown('startupFailure', 1);
});
