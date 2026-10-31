import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(file,'utf8');

test('production requires explicit machine-verifiable RPO, RTO and evidence freshness policy',()=>{
  const env=read('src/config/env.js');
  const example=read('.env.example');
  assert.match(env,/DR_MAX_RPO_MINUTES/);
  assert.match(env,/DR_MAX_RTO_MINUTES/);
  assert.match(env,/DR_EVIDENCE_MAX_AGE_DAYS/);
  assert.match(env,/Production requires explicit positive \$\{required\}/);
  assert.match(example,/DR_MAX_RPO_MINUTES=60/);
  assert.match(example,/DR_MAX_RTO_MINUTES=240/);
  assert.match(example,/DR_EVIDENCE_MAX_AGE_DAYS=90/);
});

test('launch evidence persists measured recovery metrics and launch readiness rejects stale or out-of-policy proof',()=>{
  const model=read('src/models/LaunchEvidence.js');
  const launch=read('src/services/launch.js');
  const check=read('scripts/launch-check.js');
  assert.match(model,/recoveryMetrics/);
  assert.match(model,/rpoMinutes/);
  assert.match(model,/rtoMinutes/);
  assert.match(model,/validUntil/);
  assert.match(launch,/RECOVERY_EVIDENCE_KEYS/);
  assert.match(launch,/evidence expired or has no validity window/);
  assert.match(launch,/measured RPO/);
  assert.match(launch,/measured RTO/);
  assert.match(launch,/recoveryIssues/);
  assert.match(check,/\.\.\.readiness\.recoveryIssues/);
});

test('logical restore drill is bounded, restores indexes and cannot be misrepresented as PITR proof',()=>{
  const drill=read('scripts/backup-drill.js');
  assert.match(drill,/batchSize\(500\)/);
  assert.match(drill,/createIndexes/);
  assert.match(drill,/missing restored indexes/);
  assert.match(drill,/evidenceType:'logical_restore'/);
  assert.match(drill,/pitrProven:false/);
  assert.match(drill,/rpoMinutes:null/);
  assert.match(drill,/BACKUP_DRILL_EVIDENCE_PATH must be outside the application tree/);
  assert.match(drill,/mode:0o600/);
});

test('DR documentation requires replacement-environment proof beyond Mongo logical copy',()=>{
  const dr=read('docs/production/INCIDENT_DR.md');
  const checklist=read('docs/production/RELEASE_CHECKLIST.md');
  assert.match(dr,/off-account\/off-region/);
  assert.match(dr,/object\/media storage backup/);
  assert.match(dr,/encryption, HMAC\/pepper/);
  assert.match(dr,/logical restore drill \*\*does not prove provider PITR/);
  assert.match(dr,/Evidence that is stale or exceeds policy automatically blocks/);
  assert.match(checklist,/Provider PITR exercise records measured RPO within policy/);
  assert.match(checklist,/Backup\/replacement-environment restore records measured RTO within policy/);
  assert.match(checklist,/missing\/stale\/out-of-policy RPO\/RTO recovery evidence/);
});
