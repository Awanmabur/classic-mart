import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(name)=>fs.readFileSync(path.join(root,name),'utf8');

// Stage 12 security contract: dependency-free regression coverage for the security architecture.
test('Stage 12 security contract keeps IDS IPS SIEM MFA and launch gates wired',()=>{
  const models=read('src/models/index.js');
  for(const name of ['SecurityEvent','IpBlock','SecurityFinding','LaunchEvidence','MfaRecoveryRequest'])assert.match(models,new RegExp(name));

  const user=read('src/models/User.js');
  assert.match(user,/mfaSecretEncrypted/);
  assert.match(user,/mfaRecoveryCodeHashes/);
  assert.match(user,/mfaLastCounter/);

  const mfa=read('src/services/mfa.js');
  assert.match(mfa,/createHmac\('sha1'/);
  assert.match(mfa,/mfaLastCounter'.*\$lt:counter/);
  assert.match(mfa,/\$pull:\{'security\.mfaRecoveryCodeHashes':hashed\}/);
  assert.match(mfa,/Device\.updateMany/);

  const identity=read('src/routes/identity.js');
  assert.match(identity,/mfaChallenge/);
  assert.match(identity,/verifyMfa/);

  const auth=read('src/middleware/auth.js');
  assert.match(auth,/MFA_ENROLLMENT_REQUIRED/);
  assert.match(auth,/enforcePrivilegedMfaEnrollment/);

  const security=read('src/services/security.js');
  assert.match(security,/securityDatabaseReady/,'IDS/IPS middleware must not wait on Mongoose buffering when the security database is unavailable.');
  assert.match(security,/detection\.severity===['"]critical['"]/,'Critical signature blocks must remain fail-safe during security-database degradation.');
  for(const pattern of [
    /createHmac\('sha256'/,
    /recon\.secret_probe/,
    /attack\.path_traversal/,
    /attack\.xss_probe/,
    /attack\.sql_injection_probe/,
    /attack\.jndi_probe/,
    /BLOCK_CACHE_LIMIT/,
    /BLOCK_HIT_LOG_TTL_MS/,
    /securityIncidentForBlock/,
    /ipHash:event\.ipHash/,
    /userAgentHash:event\.userAgentHash/,
    /highEventRetentionDays/,
    /processSiemQueue/,
    /verifySecurityEventIntegrity/,
    /Integrity verification failed/,
  ])assert.match(security,pattern);

  const admin=read('src/routes/admin.js');
  assert.match(admin,/\/admin\/security/);
  assert.match(admin,/different administrator must approve risk acceptance/);
  assert.match(admin,/different administrator who is not the target/);
  assert.match(admin,/invalidateIpBlockCache/);
  assert.match(admin,/mongoose\.connection\.transaction/);
  assert.match(admin,/clearMfa\(recovery\.targetUserId,'admin_mfa_recovery','',session\)/);

  const seed=read('scripts/seed.js');
  for(const name of ['SecurityEvent','IpBlock','SecurityFinding','LaunchEvidence','MfaRecoveryRequest'])assert.match(seed,new RegExp(`\\b${name}\\b`));
  assert.match(seed,/ensureLaunchEvidence\(\)/);

  const launch=read('src/services/launch.js');
  for(const key of ['penetration-test','backup-restore','pitr','waf','siem','incident-exercise','controlled-pilot'])assert.match(launch,new RegExp(key));
  assert.match(launch,/item\.status!==['"]passed['"]/);

  const launchCheck=read('scripts/launch-check.js');
  assert.match(launchCheck,/NODE_ENV must be production for launch sign-off/);

  const env=read('src/config/env.js');
  assert.match(env,/PRIVILEGED_MFA_REQUIRED=true/);
  assert.match(env,/SIEM_MODE=http or SIEM_MODE=udp/);
  assert.match(env,/explicit private\/loopback IP collector/);
  assert.match(env,/LAUNCH_COUNTRIES/);
  assert.match(env,/IDS_ENABLED=true and IPS_ENABLED=true/);
  assert.match(env,/SECURITY_HIGH_EVENT_RETENTION_DAYS/);
});
