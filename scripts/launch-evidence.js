import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { readBoundedJsonFile, readOperatorCredentials } from './operator-input.js';

export async function main(args = process.argv.slice(2)) {
  const options = { apply: false, list: false, file: null };
  for (const argument of args) {
    if (argument === '--help') {
      console.log('Usage: node scripts/launch-evidence.js --list');
      console.log('       node scripts/launch-evidence.js --file=/absolute/evidence.json [--apply]');
      console.log('Default: validate a single evidence document without database access or changes.');
      console.log('Apply: current active Super Admin password + MFA via hidden TTY or stdin JSON {actorPublicId,password,code}; never arguments or credential files.');
      console.log('Evidence: {key,expectedVersion:null|integer,status,reason,source:{key,url,description,performedAt,sha256?},validUntil?,recoveryMetrics?}.');
      console.log('List shows current versions for all 19 required gates. Existing launch requirements remain authoritative.');
      return;
    }
    if (argument === '--apply' && !options.apply) options.apply = true;
    else if (argument === '--list' && !options.list) options.list = true;
    else if (argument.startsWith('--file=') && !options.file) options.file = argument.slice('--file='.length);
    else throw new Error('Unsupported argument; use --help.');
  }
  if ((options.list && (options.file || options.apply)) || (!options.list && !options.file)) throw new Error('Choose --list or one --file; apply requires an evidence file.');
  // Even list must not create collections/indexes as a side effect of model initialization.
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  const { validateLaunchEvidence, listLaunchEvidence, applyLaunchEvidence } = await import('../src/services/launch-evidence.js');
  const input = options.file ? await readBoundedJsonFile(options.file) : null;
  const validated = input ? validateLaunchEvidence(input) : null;
  if (!options.list && !options.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', key: validated.key, status: validated.status, expectedVersion: validated.expectedVersion,
      validUntil: validated.validUntil || null, sourceKey: validated.source.key, databaseAccessed: false,
      independentVerificationPerformed: false, note: 'Format/policy validation only; source content, credentials and current database version were not verified.' }, null, 2));
    return;
  }
  const credentials = options.apply ? await readOperatorCredentials() : null;
  const { connectDatabase, disconnectDatabase } = await import('../src/config/db.js');
  try {
    await connectDatabase({ autoIndex: false });
    const result = options.list ? { mode: 'read-only', evidence: await listLaunchEvidence() } : { mode: 'applied', evidence: await applyLaunchEvidence(input, credentials) };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (credentials) { credentials.password = ''; credentials.code = ''; }
    await disconnectDatabase();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never log supplied fields, error details, driver exceptions, source contents or credential values.
    const code = typeof error.code === 'string' && /^[A-Z][A-Z_]{1,79}$/.test(error.code) ? error.code : 'LAUNCH_EVIDENCE_COMMAND_FAILED';
    console.error(`[launch-evidence] ${code}; no source content was independently verified. Review input, current authority/version and policy.`);
    process.exitCode = 1;
  });
}
