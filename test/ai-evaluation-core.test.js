import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationRunProvenance, LOCAL_EVALUATION_MODEL } from '../src/core/ai-evaluation.js';

test('Stage 10 evaluation uses truthful local provenance when generative AI is disabled', () => {
  assert.deepEqual(evaluationRunProvenance({ provider: 'disabled', model: '' }, { providerReady: false }), {
    provider: 'local', model: LOCAL_EVALUATION_MODEL,
  });
  assert.ok(LOCAL_EVALUATION_MODEL.length > 0);
});

test('Stage 10 evaluation records an external model only when that provider is actually ready', () => {
  assert.deepEqual(evaluationRunProvenance({ provider: 'openai', model: 'configured-model' }, { providerReady: true }), {
    provider: 'openai', model: 'configured-model',
  });
  assert.deepEqual(evaluationRunProvenance({ provider: 'openai', model: 'configured-model' }, { providerReady: false }), {
    provider: 'local', model: LOCAL_EVALUATION_MODEL,
  });
});
