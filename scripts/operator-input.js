/** Shared operational CLI input. Never print, persist, or put operator credentials in arguments. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

const MAX_JSON_BYTES = 16 * 1024;

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('Input must be a single bounded JSON document.'); }
}

export async function readBoundedJsonFile(file, { maxBytes = MAX_JSON_BYTES } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Input must be a bounded regular JSON file.');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('JSON input exceeds the byte limit.');
    return parseJson(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function readJsonStdin(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', error);
      input.pause();
    };
    const error = () => { cleanup(); reject(new Error('Unable to read bounded operator input.')); };
    const data = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      bytes += buffer.byteLength;
      if (bytes > MAX_JSON_BYTES) { error(); return; }
      chunks.push(buffer);
    };
    const end = () => {
      cleanup();
      try { resolve(parseJson(Buffer.concat(chunks))); }
      catch (failure) { reject(failure); }
    };
    const timer = setTimeout(error, timeoutMs);
    input.on('data', data);
    input.once('end', end);
    input.once('error', error);
    input.resume();
  });
}

/** TTY prompts suppress all input echo; pipes accept one JSON envelope until EOF (16 KiB, two minutes). */
export async function readOperatorCredentials({ input = process.stdin, output = process.stderr, timeoutMs = 120_000 } = {}) {
  if (!input.isTTY) {
    const credentials = await readJsonStdin(input, timeoutMs);
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || Object.keys(credentials).some((key) => !['actorPublicId', 'password', 'code'].includes(key))
      || ['actorPublicId', 'password', 'code'].some((key) => typeof credentials[key] !== 'string')) throw new Error('Operator input must contain only actorPublicId, password and code strings.');
    return credentials;
  }
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input, output: silent, terminal: true, historySize: 0 });
  const signal = AbortSignal.timeout(timeoutMs);
  const question = async (label) => {
    output.write(label);
    try { return await terminal.question('', { signal }); }
    finally { output.write('\n'); }
  };
  try {
    return { actorPublicId: await question('Super Admin / authorized operator public ID (hidden): '),
      password: await question('Current password (hidden): '), code: await question('Current authenticator or recovery code (hidden): ') };
  } finally { terminal.close(); silent.end(); }
}
