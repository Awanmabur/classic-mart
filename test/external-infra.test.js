import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('development is external-service first and never auto-starts or rewrites MongoDB', () => {
  const pkg = JSON.parse(read('package.json'));
  const env = read('src/config/env.js');
  const verifier = read('scripts/verify-mongo.js');
  const projectEnv = read('src/core/project-env.js');
  assert.equal(pkg.scripts.dev, 'node src/server.js');
  assert.equal(pkg.scripts['dev:watch'], 'node --watch src/server.js');
  assert.equal(pkg.scripts['db:setup'], 'npm run setup:external');
  assert.match(pkg.scripts['setup:external'], /db:verify/);
  assert.match(pkg.scripts['setup:external'], /media:r2:check/);
  assert.match(pkg.scripts['setup:external'], /seed:initial/);
  assert.doesNotMatch(pkg.scripts.dev + pkg.scripts['setup:external'], /db:local|ensure-local-mongo|reset:local/);
  assert.match(env, /mongoUri:\s*projectMongoUri\(\)/);
  assert.match(projectEnv, /MONGO_MODE/);
  assert.match(projectEnv, /\|\| 'external'/);
  assert.match(verifier, /assertMongoTransactions/);
  assert.doesNotMatch(verifier, /replSetInitiate|docker compose|db:local/);
});

test('production release cannot ship local MongoDB or starter-data tooling', () => {
  const builder = read('scripts/build-production-release.js');
  for (const token of ['scripts/ensure-local-mongo.js','scripts/stop-local-mongo.js','scripts/reset-local.js','src/core/local-mongo.js','scripts/seed-initial-catalogue.js','src/config/initial-catalogue.js']) {
    assert.match(builder, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('clean app release excludes local state and old local bootstrap tooling', () => {
  const builder = read('scripts/build-clean-app-release.js');
  const gitignore = read('.gitignore');
  assert.match(builder, /scripts\/ensure-local-mongo\.js/);
  assert.match(builder, /scripts\/reset-local\.js/);
  assert.match(builder, /src\/core\/local-mongo\.js/);
  assert.match(builder, /node_modules/);
  assert.match(builder, /storage/);
  assert.match(gitignore, /\.classic-mart\//);
  assert.match(gitignore, /storage\/uploads\//);
});

test('Redis may be local in development and is mandatory in production', () => {
  const env = read('src/config/env.js');
  const redis = read('src/config/redis.js');
  const session = read('src/middleware/session.js');
  assert.match(read('.env.example'), /^REDIS_URL=redis:\/\/127\.0\.0\.1:6379$/m);
  assert.match(env, /Production requires REDIS_URL/);
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

test('legacy Docker-local files still have an explicit safe cleanup command in engineering source', () => {
  const pkg = JSON.parse(read('package.json'));
  const cleanup = read('scripts/cleanup-legacy-infra.js');
  assert.equal(pkg.scripts['cleanup:legacy-infra'], 'node scripts/cleanup-legacy-infra.js');
  assert.match(cleanup, /compose\.yaml/);
  assert.match(cleanup, /scripts\/local-infra\.js/);
  assert.doesNotMatch(cleanup, /storage|\.env|node_modules/);
});
