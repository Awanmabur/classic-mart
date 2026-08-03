import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('local development is Docker-independent and can bootstrap MongoDB automatically', () => {
  const pkg = JSON.parse(read('package.json'));
  const env = read('src/config/env.js');
  const verifier = read('scripts/verify-mongo.js');
  const local = read('scripts/ensure-local-mongo.js');
  const localConfig = read('src/core/local-mongo.js');

  assert.equal(pkg.scripts['db:local'], 'node scripts/ensure-local-mongo.js');
  assert.match(pkg.scripts['db:setup'], /db:local/);
  assert.match(pkg.scripts.dev, /db:local/);
  assert.doesNotMatch(pkg.scripts['db:setup'], /docker|compose/i);
  assert.doesNotMatch(pkg.scripts['release:check'], /docker|compose/i);
  assert.doesNotMatch(pkg.scripts['verify:local'], /docker|compose/i);
  assert.match(env, /mongoUri:\s*projectMongoUri\(\)/);
  assert.match(read('src/core/project-env.js'), /MONGO_MODE/);
  assert.match(verifier, /assertMongoTransactions/);
  assert.doesNotMatch(verifier, /replSetInitiate|docker compose|local-infra/);
  assert.match(local, /--replSet/);
  assert.match(localConfig, /classicmart-rs/);
  assert.match(local, /CLASSIC_MART_LOCAL_REPLICA_SET/);
  assert.match(localConfig, /27018/);
  assert.match(local, /replSetInitiate/);
  assert.match(local, /MongoDB\.Server/);
  assert.match(local, /winget/);
  assert.match(local, /MONGO_URI/);
  assert.doesNotMatch(local, /docker compose|Docker Desktop/);
});

test('automatic local MongoDB never runs in production', () => {
  const local = read('scripts/ensure-local-mongo.js');
  assert.match(local, /NODE_ENV === 'production'/);
  assert.match(local, /Automatic local MongoDB bootstrap is disabled in production/);
});

test('local MongoDB state is isolated, persistent and ignored by git', () => {
  const local = read('scripts/ensure-local-mongo.js');
  const stop = read('scripts/stop-local-mongo.js');
  const gitignore = read('.gitignore');
  const dockerignore = read('.dockerignore');
  assert.match(local, /\.classic-mart/);
  assert.match(local, /mongodb/);
  assert.match(local, /mongod\.pid/);
  assert.match(stop, /Data was preserved/);
  assert.match(gitignore, /\.classic-mart\//);
  assert.match(dockerignore, /\.classic-mart/);
});

test('Redis is optional and MongoDB-backed sessions remain available', () => {
  const env = read('src/config/env.js');
  const redis = read('src/config/redis.js');
  const session = read('src/middleware/session.js');
  assert.doesNotMatch(env, /\['MONGO_URI', 'REDIS_URL', 'DATA_ENCRYPTION_KEY'\]/);
  assert.match(redis, /if \(!env\.redisUrl\) return null/);
  assert.match(session, /MongoStore\.create/);
});

test('integration audit derives an isolated database on the configured cluster', () => {
  const audit = read('scripts/audit-integration.js');
  assert.match(audit, /mongoUriWithDatabase/);
  assert.match(audit, /classic-mart-audit-test/);
  assert.match(audit, /AUDIT_MONGO_URI/);
  assert.match(audit, /dropDatabase\(\)/);
  assert.match(audit, /verify-mongo\.js/);
  assert.doesNotMatch(audit, /replSetInitiate/);
});

test('legacy Docker-local files have an explicit safe cleanup command', () => {
  const pkg = JSON.parse(read('package.json'));
  const cleanup = read('scripts/cleanup-legacy-infra.js');
  assert.equal(pkg.scripts['cleanup:legacy-infra'], 'node scripts/cleanup-legacy-infra.js');
  assert.match(cleanup, /compose\.yaml/);
  assert.match(cleanup, /scripts\/local-infra\.js/);
  assert.doesNotMatch(cleanup, /storage|\.env|node_modules/);
});
