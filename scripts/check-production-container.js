import { spawnSync } from 'node:child_process';

const [image, expectedSha] = process.argv.slice(2);
if (!image || !/^[a-z0-9][a-z0-9./:_-]{0,249}$/i.test(image)
  || !/^[a-f0-9]{40}$/.test(expectedSha || '')) {
  console.error('Usage: node scripts/check-production-container.js <image> <40-character build SHA>');
  process.exit(1);
}

// Execute with the image's own USER, dependencies and metadata. No application
// secrets, host directories, database or network are supplied to the container.
const runtimeCheck = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const QRCode = require('qrcode');
const argon2 = require('argon2');
const sharp = require('sharp');
const exists = path => {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
(async () => {
  assert.equal(process.getuid(), 10001, 'the image must use its non-root runtime identity');
  assert.equal(process.cwd(), '/app');
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(process.env.BUILD_SHA, process.argv[1]);
  for (const path of ['/usr/local/lib/node_modules/npm', '/usr/local/bin/npm', '/usr/local/bin/npx']) {
    assert.equal(exists(path), false, 'build-only npm tooling must not enter the runtime');
  }
  assert.equal(exists('/app/node_modules/@playwright/test'), false);
  for (const path of ['/app', '/app/package.json', '/app/src/server.js', '/app/src/worker.js',
    '/app/scripts/run-production.js', '/app/scripts/migrate-production.js',
    '/app/scripts/bootstrap-production.js', '/app/scripts/check-production-data.js']) {
    fs.accessSync(path, fs.constants.R_OK);
    assert.equal(fs.statSync(path).mode & 0o222, 0, 'runtime code must have no write bits: ' + path);
  }
  const png = await QRCode.toBuffer('https://example.test/public-product', { width: 256, margin: 4 });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 256);
  const password = 'Isolated production-runtime verification';
  assert.equal(await argon2.verify(await argon2.hash(password), password), true);
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal(photo.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  console.log(JSON.stringify({ scope: 'production container runtime', uid: process.getuid(),
    node: process.versions.node, buildSha: process.env.BUILD_SHA, qr: true,
    passwordHashing: true, imageEncoding: true, sourceReadOnly: true, npmAbsent: true }));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
`;

const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m',
  '--entrypoint', 'node', image, '-e', runtimeCheck, expectedSha],
{ encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const failed = result.error || result.status !== 0;
if (failed && process.env.GITHUB_ACTIONS === 'true') {
  const reason = (result.error?.message || result.stderr || 'Production container runtime verification failed.').slice(-6000);
  const escaped = reason.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error('::error title=Production container runtime::' + escaped);
}
if (result.error) console.error(result.error.message);
process.exitCode = failed ? 1 : 0;
