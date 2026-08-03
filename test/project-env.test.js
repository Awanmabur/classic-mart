import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMongoMode, projectMongoUri, projectAuditMongoUri, projectMongoPort } from '../src/core/project-env.js';

function withEnv(values, fn) {
  const before = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('local mode makes project .env MongoDB authority stronger than inherited Windows variables', () => withEnv({
  NODE_ENV: 'development',
  MONGO_URI: 'mongodb+srv://stale.example/classic-mart',
  AUDIT_MONGO_URI: 'mongodb+srv://stale.example/classic-mart-audit-test',
  CLASSIC_MART_MONGO_PORT: '29999',
}, () => {
  const source = [
    'MONGO_MODE=local',
    'MONGO_URI=mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs',
    'AUDIT_MONGO_URI=',
    'CLASSIC_MART_MONGO_PORT=27018',
    '',
  ].join('\n');
  assert.equal(projectMongoMode({ source }), 'local');
  assert.equal(projectMongoUri({ source }), 'mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs');
  assert.equal(projectAuditMongoUri({ source }), '');
  assert.equal(projectMongoPort({ source }), 27018);
}));

test('external development mode explicitly permits external process MongoDB values', () => withEnv({
  NODE_ENV: 'development', MONGO_URI: 'mongodb+srv://wanted.example/classic-mart',
}, () => {
  const source = 'MONGO_MODE=external\nMONGO_URI=\n';
  assert.equal(projectMongoUri({ source }), 'mongodb+srv://wanted.example/classic-mart');
}));

test('production remains environment-first and external', () => withEnv({
  NODE_ENV: 'production', MONGO_URI: 'mongodb+srv://prod.example/classic-mart',
}, () => {
  const source = 'MONGO_MODE=local\nMONGO_URI=mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs\n';
  assert.equal(projectMongoMode({ source }), 'external');
  assert.equal(projectMongoUri({ source }), 'mongodb+srv://prod.example/classic-mart');
}));


test('ordinary test mode ignores inherited MongoDB while integration audit can opt in explicitly', () => withEnv({
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb+srv://stale.example/classic-mart',
  CLASSIC_MART_TEST_MONGO_OVERRIDE: undefined,
}, () => {
  assert.equal(projectMongoUri({ source: 'MONGO_MODE=local\nMONGO_URI=mongodb://127.0.0.1:27018/classic-mart?replicaSet=classicmart-rs\n' }), '');
}));

test('integration audit test override uses its explicit isolated MongoDB URI', () => withEnv({
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://127.0.0.1:27018/classic-mart-audit-test?replicaSet=classicmart-rs',
  CLASSIC_MART_TEST_MONGO_OVERRIDE: '1',
}, () => {
  assert.match(projectMongoUri({ source: 'MONGO_MODE=local\nMONGO_URI=\n' }), /classic-mart-audit-test/);
}));
