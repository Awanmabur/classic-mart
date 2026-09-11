import os from 'node:os';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { disconnectRedis, getRedisClient } from './config/redis.js';
import { logger } from './config/logger.js';
import { ensureStorageReady } from './config/storage.js';
import { WorkerHeartbeat } from './models/WorkerHeartbeat.js';
import { runMaintenanceCycle } from './services/maintenance.js';

let shuttingDown=false;let timer=null;let running=false;
const hostname=os.hostname();
const workerId=`maintenance:${process.env.RENDER_INSTANCE_ID||process.env.HOSTNAME||hostname}:${process.pid}`;
const startedAt=new Date();
const HEARTBEAT_TTL_MS=3*60_000;
function expiresAt(ms=HEARTBEAT_TTL_MS){return new Date(Date.now()+ms);}
async function heartbeat(patch={}){
  try{
    const now=new Date();
    await WorkerHeartbeat.updateOne(
      {workerId},
      {$set:{role:'maintenance',hostname,pid:process.pid,status:'running',lastHeartbeatAt:now,expiresAt:expiresAt(),...patch},$setOnInsert:{startedAt}},
      {upsert:true},
    );
  }catch(error){logger.warn({error,workerId},'Worker heartbeat write failed');}
}
async function cycle(){
  if(running||shuttingDown)return;
  running=true;const cycleStartedAt=new Date(),started=Date.now();
  await heartbeat({lastCycleStartedAt:cycleStartedAt});
  try{
    const result=await runMaintenanceCycle();
    await heartbeat({lastCycleCompletedAt:new Date(),lastCycleDurationMs:Date.now()-started,lastCycleOk:true,lastError:''});
    logger.info({result},'Worker maintenance cycle completed');
  }catch(error){
    await heartbeat({status:'error',lastCycleCompletedAt:new Date(),lastCycleDurationMs:Date.now()-started,lastCycleOk:false,lastError:String(error?.message||error).slice(0,1000)});
    logger.error({error},'Worker maintenance cycle failed');
  }finally{running=false;}
}
async function start(){await ensureStorageReady();await connectDatabase();await getRedisClient();await heartbeat();await cycle();timer=setInterval(cycle,60_000);timer.unref();logger.info({pid:process.pid,workerId},'Classic Mart worker ready');}
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;if(timer)clearInterval(timer);logger.info({signal,workerId},'Classic Mart worker shutting down');const deadline=Date.now()+10_000;while(running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));await heartbeat({status:'stopping',expiresAt:expiresAt(30_000)});await Promise.allSettled([disconnectRedis(),disconnectDatabase()]);process.exit(0);}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));process.on('uncaughtException',error=>{logger.fatal({error},'Worker uncaught exception');shutdown('uncaughtException');});process.on('unhandledRejection',error=>{logger.fatal({error},'Worker unhandled rejection');shutdown('unhandledRejection');});
start().catch(error=>{logger.fatal({error},'Worker startup failed');process.exit(1);});
