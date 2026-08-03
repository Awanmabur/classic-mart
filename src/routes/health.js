import { Router } from 'express';
import { isDatabaseReady } from '../config/db.js';
import { env } from '../config/env.js';
import { isRedisReady } from '../config/redis.js';

const router = Router();

router.get('/health/live', (_request, response) => {
  response.json({ status: 'ok' });
});

router.get('/health/ready', (_request, response) => {
  const mongo = isDatabaseReady();
  const redis = !env.redisUrl || isRedisReady();
  response.status(mongo && redis ? 200 : 503).json({
    status: mongo && redis ? 'ready' : 'not_ready',
    checks: { mongo, redis },
  });
});

export default router;
