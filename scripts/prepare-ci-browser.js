import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/** Share Playwright's installed binary with both current and legacy live tests. */
export async function prepareCiBrowserEnvironment({ environmentFile = process.env.GITHUB_ENV,
  executablePath = chromium.executablePath() } = {}) {
  assert.ok(typeof environmentFile === 'string' && path.isAbsolute(environmentFile),
    'CI browser setup requires the existing absolute GITHUB_ENV file.');
  assert.ok(typeof executablePath === 'string' && path.isAbsolute(executablePath)
    && !/[\u0000-\u001f\u007f]/.test(executablePath),
  'The installed Chromium executable must be an absolute, single-line path.');
  assert.ok((await fs.stat(executablePath)).isFile(), 'The Chromium executable must be a file.');
  await fs.access(executablePath, constants.X_OK);
  // Do not create a mistyped environment file or follow a substituted symlink.
  const handle = await fs.open(environmentFile,
    constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0));
  try {
    assert.ok((await handle.stat()).isFile(), 'GITHUB_ENV must be a regular file.');
    // A leading separator also handles an existing final line without a newline.
    await handle.writeFile(`\nPLAYWRIGHT_CHROMIUM_EXECUTABLE=${executablePath}\nPLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${executablePath}\n`);
  } finally { await handle.close(); }
  return executablePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareCiBrowserEnvironment().then(() => {
    console.log('Installed Playwright Chromium verified for all CI browser tests.');
  }).catch(error => {
    console.error('CI browser setup failed:', error.message);
    process.exitCode = 1;
  });
}
