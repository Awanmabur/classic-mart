import { parseArgs } from 'node:util';
import { readBoundedJsonFile, readOperatorCredentials } from './operator-input.js';

const usage = 'Usage: npm run staff:access -- invite|list|approve [--input-file /path/to/options.json] [--apply]\nCredentials are read through hidden terminal input or stdin JSON {actorPublicId,password,code}.\nInvite and approve default to dry-run. Acceptance, verification and independent approval remain required.';
let disconnect;
try {
  const { values, positionals } = parseArgs({ options: { 'input-file': { type: 'string' }, apply: { type: 'boolean', default: false }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 1 || !['invite', 'list', 'approve'].includes(positionals[0])) throw Object.assign(new Error('Invalid action.'), { code: 'STAFF_OPERATION_INVALID' });
    const action = positionals[0];
    if (action !== 'list' && !values['input-file']) throw Object.assign(new Error('Input file required.'), { code: 'STAFF_INPUT_REQUIRED' });
    const input = values['input-file'] ? await readBoundedJsonFile(values['input-file']) : {};
    const credentials = await readOperatorCredentials();
    const database = await import('../src/config/db.js');
    disconnect = database.disconnectDatabase;
    await database.connectDatabase({ autoIndex: false });
    const { runStaffOperation } = await import('../src/services/staff-operations.js');
    const result = await runStaffOperation(credentials, { ...input, action, apply: values.apply });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : error?.name === 'ZodError' ? 'STAFF_INPUT_INVALID' : 'STAFF_OPERATION_FAILED';
  console.error(`Staff operation failed (${code}).`);
  process.exitCode = 1;
} finally { if (disconnect) await disconnect().catch(() => { process.exitCode = 1; }); }
