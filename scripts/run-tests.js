import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runWithCiTestServices } from './ci-test-services.js';

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && ent.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const files = walk(path.resolve('test')).sort();
if (!files.length) {
  console.error('No canonical tests found under test/.');
  process.exit(1);
}
const nodeArgs = ['--test', '--test-reporter=spec'];
if (process.env.GITHUB_ACTIONS === 'true') {
  // Keep the complete human-readable report and also publish actual leaf
  // failures as check-run annotations when hosted log downloads are unavailable.
  nodeArgs.push('--test-reporter-destination=stdout',
    '--test-reporter=' + fileURLToPath(new URL('./github-test-reporter.js', import.meta.url)),
    '--test-reporter-destination=stdout');
}
// Live fixtures create and drop isolated databases on the same MongoDB server.
// Serialize those files so index construction and teardown cannot interfere.
if (process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI) {
  nodeArgs.push('--test-concurrency=1', '--import', fileURLToPath(new URL('./live-test-model-lifecycle.js', import.meta.url)));
}
if (process.argv.includes('--coverage')) nodeArgs.push('--experimental-test-coverage');
if (process.env.GITHUB_ACTIONS === 'true' && process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI && process.platform === 'linux') {
  // Repeated isolated databases/index builds make MongoDB's allocator retain
  // memory across a very long suite. Run every file, but split the suite into
  // deterministic shards and restart only the disposable CI MongoDB between
  // shards so allocator growth cannot turn a passing suite into runner OOM.
  const shardCount = Math.max(1, Math.min(8, Number(process.env.CLASSIC_MART_CI_TEST_SHARDS) || 4));
  async function resetDisposableServices() {
    const restarted = spawnSync('docker', ['restart', 'classic-mart-mongo'], { stdio: 'inherit', shell: false });
    if (restarted.status !== 0) throw new Error('Could not restart disposable CI MongoDB between test shards.');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = spawnSync('docker', ['exec', 'classic-mart-mongo', 'mongosh', '--port', '27019', '--quiet',
        '--eval', 'if(!db.hello().isWritablePrimary) quit(1)'], { stdio: 'ignore', shell: false });
      if (ready.status === 0) break;
      if (attempt === 59) throw new Error('Disposable CI MongoDB did not return as writable primary after restart.');
      await delay(1000);
    }
    const flushed = spawnSync('docker', ['exec', 'classic-mart-redis', 'redis-cli', 'FLUSHALL'], { stdio: 'ignore', shell: false });
    if (flushed.status !== 0) throw new Error('Could not reset disposable CI Redis between test shards.');
  }
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    if (shardIndex) await resetDisposableServices();
    const shardFiles = files.filter((_file, index) => index % shardCount === shardIndex);
    if (!shardFiles.length) continue;
    console.log(`CI test shard ${shardIndex + 1}/${shardCount}: ${shardFiles.length} files`);
    const code = await runWithCiTestServices({ args: [...nodeArgs, ...shardFiles] });
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
} else {
  const result = spawnSync(process.execPath, [...nodeArgs, ...files], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
