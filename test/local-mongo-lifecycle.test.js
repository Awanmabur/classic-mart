import test from 'node:test';
import assert from 'node:assert/strict';
import { envValues, envLastValue, upsertUniqueEnvValue } from '../src/core/env-file.js';
import {
  CLASSIC_MART_LOCAL_REPLICA_SET,
  classicMartManagedMongoUri,
  parseClassicMartManagedMongoUri,
  resolveDevelopmentMongoBootstrap,
} from '../src/core/local-mongo.js';

test('recognizes Classic Mart managed local MongoDB URIs across loopback spellings', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const parsed = parseClassicMartManagedMongoUri(
      `mongodb://${host}:27018/classic-mart?retryWrites=true&replicaSet=${CLASSIC_MART_LOCAL_REPLICA_SET}`,
    );
    assert.equal(parsed?.port, 27018);
  }
  assert.equal(parseClassicMartManagedMongoUri('mongodb://127.0.0.1:27018/classic-mart'), null);
  assert.equal(parseClassicMartManagedMongoUri('mongodb://127.0.0.1:27018/other?replicaSet=classicmart-rs'), null);
  assert.equal(parseClassicMartManagedMongoUri('mongodb://db.example:27018/classic-mart?replicaSet=classicmart-rs'), null);
});

test('generates the canonical Classic Mart managed local URI', () => {
  assert.equal(
    classicMartManagedMongoUri(27018),
    'mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs',
  );
});

test('environment updater collapses duplicate managed settings to one canonical value', () => {
  const source = [
    'PORT=3000',
    'MONGO_URI=mongodb+srv://old.example/classic-mart',
    'REDIS_URL=',
    'MONGO_URI="mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs"',
    'MONGO_URI=mongodb://stale.example/classic-mart',
    '',
  ].join('\n');

  assert.deepEqual(envValues(source, 'MONGO_URI'), [
    'mongodb+srv://old.example/classic-mart',
    'mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs',
    'mongodb://stale.example/classic-mart',
  ]);
  assert.equal(envLastValue(source, 'MONGO_URI'), 'mongodb://stale.example/classic-mart');

  const canonical = upsertUniqueEnvValue(
    source,
    'MONGO_URI',
    classicMartManagedMongoUri(27018),
  );
  assert.equal(envValues(canonical, 'MONGO_URI').length, 1);
  assert.equal(envLastValue(canonical, 'MONGO_URI'), classicMartManagedMongoUri(27018));
  assert.match(canonical, /^PORT=3000$/m);
  assert.match(canonical, /^REDIS_URL=$/m);
});

test('local bootstrap source explicitly restarts an unreachable managed URI and recovers duplicate env state', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../scripts/ensure-local-mongo.js', import.meta.url), 'utf8');
  assert.match(source, /managed local MongoDB is not reachable[\s\S]*restarting it with preserved data/i);
  assert.match(source, /SAVED_MANAGED_LOCAL/);
  assert.match(source, /stale duplicate MONGO_URI/i);
  assert.match(source, /upsertUniqueEnvValue/);
});


test('fresh local mode ignores inherited external MONGO_URI values', () => {
  const resolved = resolveDevelopmentMongoBootstrap({
    mode: 'local',
    envMongoUri: '',
    processMongoUri: 'mongodb+srv://stale.example/classic-mart',
  });
  assert.deepEqual(resolved, { mode: 'local', uri: '' });
});

test('external development MongoDB requires explicit opt-in', () => {
  const uri = 'mongodb+srv://user:password@example.mongodb.net/classic-mart';
  assert.deepEqual(
    resolveDevelopmentMongoBootstrap({ mode: 'external', envMongoUri: '', processMongoUri: uri }),
    { mode: 'external', uri },
  );
  assert.throws(
    () => resolveDevelopmentMongoBootstrap({ mode: 'anything-else' }),
    /MONGO_MODE must be either local or external/,
  );
});


test('fresh local configuration declares deterministic local mode', async () => {
  const fs = await import('node:fs');
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^MONGO_MODE=local$/m);
  assert.match(env, /^MONGO_URI=$/m);
});


test('blank env values never consume the following line', () => {
  const source = 'MONGO_MODE=local\nMONGO_URI=\nCLASSIC_MART_MONGO_PORT=27018\nAUDIT_MONGO_URI=\nREDIS_URL=\n';
  assert.deepEqual(envValues(source, 'MONGO_URI'), ['']);
  assert.equal(envLastValue(source, 'MONGO_URI'), '');
  assert.deepEqual(envValues(source, 'AUDIT_MONGO_URI'), ['']);
  assert.equal(envLastValue(source, 'AUDIT_MONGO_URI'), '');
  assert.equal(envLastValue(source, 'CLASSIC_MART_MONGO_PORT'), '27018');
});
