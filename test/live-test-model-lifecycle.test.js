import test from 'node:test';
import assert from 'node:assert/strict';
import { settleModelInitialization } from '../scripts/live-test-model-lifecycle.js';

test('live fixture cleanup waits for every registered model initialization', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let complete = false;
  const models = { immediate: { init: async () => {} }, pending: { init: () => pending } };
  const cleanup = settleModelInitialization({ models }).then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  finish();
  await cleanup;
  assert.equal(complete, true);
});

test('live fixture cleanup includes models registered while initialization finishes', async () => {
  const initialized = [];
  const models = {
    first: { init: async () => {
      initialized.push('first');
      models.later = { init: async () => { initialized.push('later'); } };
    } },
  };
  await settleModelInitialization({ models });
  assert.deepEqual(initialized, ['first', 'later']);
});

test('live fixture cleanup preserves collection and index initialization failures', async () => {
  const failure = new Error('unique index creation failed');
  await assert.rejects(settleModelInitialization({ models: { rejected: { init: async () => { throw failure; } } } }), error => error === failure);
});
