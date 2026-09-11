import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Router } from 'express';
import { isDatabaseReady } from '../config/db.js';
import { env } from '../config/env.js';
import { isRedisReady } from '../config/redis.js';
import { prometheusMetrics } from '../services/invariants.js';

const require = createRequire(import.meta.url);
const { version: applicationVersion } = require('../../package.json');
const router = Router();
function safeEqual(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&aa.length>0&&crypto.timingSafeEqual(aa,bb);}
router.get('/health/live', (_request, response) => response.json({ status: 'ok' }));
router.get('/health/version', (_request, response) => response.json({ status: 'ok', version: applicationVersion, buildSha: env.buildSha || null }));
router.get('/health/ready', (_request, response) => {
  const mongo = isDatabaseReady();
  const redis = !env.redisUrl || isRedisReady();
  response.status(mongo && redis ? 200 : 503).json({ status: mongo && redis ? 'ready' : 'not_ready', checks: { mongo, redis } });
});
router.get('/internal/metrics', async (request,response,next)=>{
  try{
    if(!env.metricsToken||env.metricsToken.length<32)return response.status(404).end();
    const supplied=String(request.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(!safeEqual(supplied,env.metricsToken))return response.status(401).set('WWW-Authenticate','Bearer').end();
    response.type('text/plain; version=0.0.4').send(await prometheusMetrics());
  }catch(error){next(error);}
});
export default router;
