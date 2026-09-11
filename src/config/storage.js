import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { ensureMediaStorageReady } from '../services/object-storage.js';

export async function ensureStorageReady() {
  const directories = [env.exportDir, env.privacyExportDir];
  if (env.mediaStorageDriver === 'filesystem') directories.unshift(env.uploadDir);
  for (const directory of directories) await fs.mkdir(directory, { recursive: true });
  await ensureMediaStorageReady();
  if (!env.isProduction) return;

  const probe = path.join(env.persistentStorageRoot, `.classic-mart-write-probe-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(probe, 'storage-ready\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } finally {
    await fs.unlink(probe).catch(() => {});
  }
}
