import http from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { disconnectRedis, getRedisClient } from './config/redis.js';
import { runMaintenanceCycle } from './services/maintenance.js';

let server;
let shuttingDown = false;
let maintenanceTimer;

async function start() {
  await connectDatabase();
  const redis = await getRedisClient();
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
  server.listen(env.port, '0.0.0.0', () => {
    logger.info({ port: env.port }, 'Classic Mart ready');
  });
  const runMaintenance = () => runMaintenanceCycle().catch((error) => logger.warn({ error }, 'Maintenance cycle failed'));
  runMaintenance();
  maintenanceTimer = setInterval(runMaintenance, 60_000);
  maintenanceTimer.unref();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await Promise.allSettled([disconnectRedis(), disconnectDatabase()]);
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.fatal({ error }, 'Unhandled rejection');
  shutdown('unhandledRejection');
});

start().catch((error) => {
  logger.fatal({ error }, 'Startup failed');
  process.exit(1);
});
