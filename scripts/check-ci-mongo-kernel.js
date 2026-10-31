import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubServiceFailureAnnotation } from './ci-service-diagnostics.js';

// SERVER-121912: the pinned MongoDB 8.0.32 image refuses Linux >= 6.19.
// Runner labels can retain their name while the hosted kernel changes.
export function assertCiMongoKernel({ platform = os.platform(), release = os.release() } = {}) {
  if (platform !== 'linux') throw new Error('The MongoDB CI service requires a Linux runner.');
  const version = typeof release === 'string' && release.length <= 128
    ? /^(\d+(?:\.\d+)+)(?:[-+][A-Za-z0-9_][A-Za-z0-9._+~-]*)?$/.exec(release) : null;
  if (!version) {
    throw new Error('Cannot validate the Linux runner kernel release for MongoDB.');
  }
  const components = version[1].split('.').map(Number);
  if (components.some(value => !Number.isSafeInteger(value))) {
    throw new Error('Cannot validate the Linux runner kernel version for MongoDB.');
  }
  const [major, minor] = components;
  if (major > 6 || major === 6 && minor >= 19) {
    throw new Error(`MongoDB 8.0.32 cannot start on Linux ${release}. Use a runner with a kernel older than 6.19 until a validated MongoDB fix is available. See https://jira.mongodb.org/browse/SERVER-121912.`);
  }
  return { platform, kernel: release, mongoVersion: '8.0.32' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const info = assertCiMongoKernel();
    process.stdout.write(`CI MongoDB kernel check passed: Linux ${info.kernel}, MongoDB ${info.mongoVersion}.\n`);
  } catch (error) {
    process.stdout.write(githubServiceFailureAnnotation(error.message, { title: 'CI MongoDB runner kernel' }));
    process.exitCode = 1;
  }
}
