import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { env } = await import('../src/config/env.js');
const { launchEvidenceIssues, recoveryEvidenceIssues, satisfiesLaunchEvidence } = await import('../src/services/launch.js');
const { validateLaunchEvidence } = await import('../src/services/launch-evidence.js');
const now = new Date('2026-10-14T14:00:00.000Z');
const hour = 3_600_000;
const maxAge = env.disasterRecovery.evidenceMaxAgeDays * 86_400_000;
const proof = (changes = {}) => ({ key: 'load-test', status: 'passed', verifiedAt: new Date(now - hour), validUntil: new Date(+now + hour), ...changes });

test('every launch gate requires current, valid and bounded verification and expiry timestamps', () => {
  assert.equal(satisfiesLaunchEvidence(proof(), now), true);
  for (const changes of [
    { verifiedAt: undefined }, { verifiedAt: 'invalid' }, { verifiedAt: new Date(+now + 1) },
    { validUntil: undefined }, { validUntil: 'invalid' }, { validUntil: now },
    { verifiedAt: new Date(+now - maxAge - 1) }, { validUntil: new Date(+now + maxAge) },
    { status: 'not_applicable' }, { status: 'missing' }, { status: 'failed' },
  ]) assert.equal(satisfiesLaunchEvidence(proof(changes), now), false, JSON.stringify(changes));
  assert.ok(launchEvidenceIssues([proof({ validUntil: now })], now).some(issue => issue.includes('load-test: evidence expired')));
  assert.equal(satisfiesLaunchEvidence(null, now), false);
});

test('recovery policy rejects null, negative and out-of-order measurements even when marked passed', () => {
  const pitr = proof({ key: 'pitr', recoveryMetrics: { rpoMinutes: 0 } });
  assert.equal(satisfiesLaunchEvidence(pitr, now), true);
  for (const value of [null, undefined, '', -1, Infinity, NaN, env.disasterRecovery.maxRpoMinutes + 1]) {
    assert.ok(recoveryEvidenceIssues([{ ...pitr, recoveryMetrics: { rpoMinutes: value } }], now).length > 0);
  }
  const restored = proof({ key: 'backup-restore', recoveryMetrics: {
    rtoMinutes: 1, sourceSnapshotAt: new Date(now - 3 * hour), restoredAt: new Date(now - 2 * hour),
  } });
  assert.equal(satisfiesLaunchEvidence(restored, now), true);
  for (const changes of [
    { rtoMinutes: null }, { sourceSnapshotAt: 'invalid' }, { restoredAt: undefined },
    { sourceSnapshotAt: now }, { restoredAt: now },
    { sourceSnapshotAt: new Date(now - 1.5 * hour) },
  ]) assert.equal(satisfiesLaunchEvidence({ ...restored, recoveryMetrics: { ...restored.recoveryMetrics, ...changes } }, now), false, JSON.stringify(changes));
});

test('optional PITR snapshot must precede the exercise even without a restore timestamp', () => {
  const input = { key: 'pitr', status: 'passed', expectedVersion: null, reason: 'Reviewed genuine provider recovery exercise.',
    source: { key: 'pitr', url: 'https://evidence.example.com/pitr', description: 'Actual measured recovery evidence for operator review.', performedAt: new Date(now - 2 * hour).toISOString() },
    validUntil: new Date(+now + hour).toISOString(),
    recoveryMetrics: { drillId: 'exercise-1', provider: 'Provider', scope: 'Disposable verification database.', rpoMinutes: 1, sourceSnapshotAt: new Date(now - hour).toISOString() },
  };
  assert.throws(() => validateLaunchEvidence(input, { now }), { code: 'LAUNCH_EVIDENCE_INVALID' });
  input.recoveryMetrics.sourceSnapshotAt = new Date(now - 3 * hour).toISOString();
  assert.equal(validateLaunchEvidence(input, { now }).key, 'pitr');
});
