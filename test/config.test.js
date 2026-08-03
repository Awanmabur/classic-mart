import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('production refuses implicit infrastructure and secrets', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envModule = pathToFileURL(path.join(root, 'src/config/env.js')).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(envModule)})`],
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        MONGO_URI: '',
        REDIS_URL: '',
        SESSION_SECRET: '',
        TOKEN_PEPPER: '',
        DATA_ENCRYPTION_KEY: '',
        MAIL_MODE: '',
        SMTP_HOST: '',
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MONGO_URI must be explicitly set/);
});
