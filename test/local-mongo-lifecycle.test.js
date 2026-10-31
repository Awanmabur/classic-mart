import test from 'node:test';
import assert from 'node:assert/strict';
import { envValues, envLastValue, upsertUniqueEnvValue } from '../src/core/env-file.js';
import { projectMongoMode, projectMongoUri } from '../src/core/project-env.js';

test('external mode is the development default', () => {
  assert.equal(projectMongoMode({ nodeEnv: 'development', source: '' }), 'external');
});

test('external development resolves the configured Atlas URI without rewriting it', () => {
  const source = [
    'MONGO_MODE=external',
    'MONGO_URI=mongodb+srv://user:password@example.mongodb.net/classic-mart-dev',
    '',
  ].join('\n');
  assert.equal(projectMongoMode({ nodeEnv: 'development', source }), 'external');
  // This test supplies a file fixture; the runner's live MongoDB URI must not
  // take precedence over that fixture or leak into the assertion output.
  const originalProcessMongoUri = process.env.MONGO_URI;
  delete process.env.MONGO_URI;
  try {
    assert.equal(
      projectMongoUri({ nodeEnv: 'development', source }),
      'mongodb+srv://user:password@example.mongodb.net/classic-mart-dev',
    );
  } finally {
    if (originalProcessMongoUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = originalProcessMongoUri;
  }
});

test('environment updater still collapses duplicate managed settings safely', () => {
  const source = [
    'PORT=3000',
    'MONGO_URI=mongodb+srv://old.example/classic-mart-dev',
    'REDIS_URL=',
    'MONGO_URI=mongodb+srv://new.example/classic-mart-dev',
    '',
  ].join('\n');
  assert.deepEqual(envValues(source, 'MONGO_URI'), [
    'mongodb+srv://old.example/classic-mart-dev',
    'mongodb+srv://new.example/classic-mart-dev',
  ]);
  assert.equal(envLastValue(source, 'MONGO_URI'), 'mongodb+srv://new.example/classic-mart-dev');
  const canonical = upsertUniqueEnvValue(source, 'MONGO_URI', 'mongodb+srv://final.example/classic-mart-dev');
  assert.equal(envValues(canonical, 'MONGO_URI').length, 1);
  assert.equal(envLastValue(canonical, 'MONGO_URI'), 'mongodb+srv://final.example/classic-mart-dev');
});

test('fresh configuration declares the explicit real Atlas database and R2 storage', async () => {
  const fs = await import('node:fs');
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^MONGO_MODE=external$/m);
  assert.match(env, /classic-mart\?retryWrites=true/);
  assert.match(env, /^MEDIA_STORAGE_DRIVER=r2$/m);
  assert.match(env, /^R2_BUCKET=classic-mart-media$/m);
});

test('blank env values never consume the following line', () => {
  const source = [
    'MONGO_MODE=external',
    'MONGO_URI=',
    'AUDIT_MONGO_URI=',
    'REDIS_URL=redis://127.0.0.1:6379',
    '',
  ].join('\n');
  assert.deepEqual(envValues(source, 'MONGO_URI'), ['']);
  assert.equal(envLastValue(source, 'MONGO_URI'), '');
  assert.deepEqual(envValues(source, 'AUDIT_MONGO_URI'), ['']);
  assert.equal(envLastValue(source, 'AUDIT_MONGO_URI'), '');
  assert.equal(envLastValue(source, 'REDIS_URL'), 'redis://127.0.0.1:6379');
});
