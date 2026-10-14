import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('actual worker publishes a successful current-build cycle and shutdown withdraws readiness', { skip: !uri, timeout: 120_000 }, async () => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  target.pathname = '/classicmart_worker_process_test_' + suffix;
  const ownUri = target.href;
  const buildSha = crypto.randomBytes(20).toString('hex');
  const uploadDir = '/tmp/classicmart-worker-process-' + suffix;
  const logPath = '/tmp/classicmart-worker-process-' + suffix + '.log';
  const log = fs.openSync(logPath, 'w');
  let worker, exit, spawnError;
  try {
    await mongoose.connect(ownUri);
    const models = await import('../src/models/index.js');
    for (const model of Object.values(models)) if (model?.init) await model.init();
    const { createWorkerReadiness } = await import('../src/services/worker-readiness.js');
    worker = spawn(process.execPath, ['src/worker.js'], { cwd: new URL('../', import.meta.url), stdio: ['ignore',log,log], env: {
      ...process.env, NODE_ENV:'test', CLASSIC_MART_TEST_MONGO_OVERRIDE:'1', MONGO_URI:ownUri, REDIS_URL:'',
      BUILD_SHA:buildSha, MAIL_MODE:'log', SMS_MODE:'log', AI_PROVIDER:'disabled',
      MEDIA_STORAGE_DRIVER:'filesystem', UPLOAD_DIR:uploadDir, MALWARE_SCAN_MODE:'off',
      SESSION_SECRET:crypto.randomBytes(48).toString('base64url'),TOKEN_PEPPER:crypto.randomBytes(48).toString('base64url'),
      DATA_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),SECURITY_INTEGRITY_KEY:crypto.randomBytes(48).toString('base64url'),
    } });
    exit = new Promise(resolve => {
      worker.once('exit',(code,signal)=>resolve({code,signal}));
      worker.once('error',error=>{spawnError=error;resolve({code:null,signal:null});});
    });
    const ready = createWorkerReadiness({ required:true,buildSha,cacheMs:0 });
    let completed = false;
    for (let attempt=0; attempt<120; attempt++) {
      if(await ready()){completed=true;break;}
      assert.equal(spawnError,undefined,'The worker process must start.');
      assert.equal(worker.exitCode,null,'Worker must stay alive until explicitly stopped.');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(completed,true,'Actual maintenance must complete successfully; inspect '+logPath);
    const beat = await models.WorkerHeartbeat.findOne({pid:worker.pid,buildSha}).lean();
    assert.equal(beat.status,'running');assert.equal(beat.lastCycleOk,true);
    assert.ok(beat.lastCycleCompletedAt>=beat.lastCycleStartedAt);
    worker.kill('SIGTERM');
    const result = await exit;
    assert.deepEqual(result,{code:0,signal:null});
    assert.equal(await ready(),false,'The actual stopping heartbeat must withdraw readiness.');
  } finally {
    if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGTERM');await exit;}
    fs.closeSync(log);
    if(mongoose.connection.readyState===1){await mongoose.connection.dropDatabase();await mongoose.disconnect();}
    fs.rmSync(uploadDir,{recursive:true,force:true});
  }
});
