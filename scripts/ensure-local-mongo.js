import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import { envValues, upsertUniqueEnvValue } from '../src/core/env-file.js';
import {
  CLASSIC_MART_DEFAULT_MONGO_PORT,
  CLASSIC_MART_LOCAL_REPLICA_SET,
  classicMartManagedMongoUri,
  parseClassicMartManagedMongoUri,
  resolveDevelopmentMongoBootstrap,
} from '../src/core/local-mongo.js';

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, '.classic-mart');
const DB_DIR = path.join(STATE_DIR, 'mongodb');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const PID_FILE = path.join(STATE_DIR, 'mongod.pid');
const ENV_FILE = path.join(ROOT, '.env');
const REPLICA_SET = CLASSIC_MART_LOCAL_REPLICA_SET;
const DEFAULT_LOCAL_PORT = CLASSIC_MART_DEFAULT_MONGO_PORT;
const INITIAL_ENV_SOURCE = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
const ENV_MONGO_VALUES = envValues(INITIAL_ENV_SOURCE, 'MONGO_URI');
const PROCESS_MONGO_URI = String(process.env.MONGO_URI || '').trim();
const ENV_MONGO_MODE_VALUES = envValues(INITIAL_ENV_SOURCE, 'MONGO_MODE');
const MONGO_MODE = String(ENV_MONGO_MODE_VALUES.at(-1) || process.env.MONGO_MODE || 'local').trim().toLowerCase();
const bootstrapConfig = resolveDevelopmentMongoBootstrap({
  mode: MONGO_MODE,
  envMongoUri: ENV_MONGO_VALUES.at(-1) || '',
  processMongoUri: PROCESS_MONGO_URI,
});
const CONFIGURED_MONGO_URI = bootstrapConfig.uri;
const SAVED_MANAGED_LOCAL = [...ENV_MONGO_VALUES].reverse().map(parseClassicMartManagedMongoUri).find(Boolean) || null;
const CONFIGURED_MANAGED_LOCAL = parseClassicMartManagedMongoUri(CONFIGURED_MONGO_URI);
const MANAGED_LOCAL = CONFIGURED_MANAGED_LOCAL || SAVED_MANAGED_LOCAL;
const ENV_PORT_VALUES = envValues(INITIAL_ENV_SOURCE, 'CLASSIC_MART_MONGO_PORT');
const configuredPort = Number.parseInt(ENV_PORT_VALUES.at(-1) || process.env.CLASSIC_MART_MONGO_PORT || '', 10);
const LOCAL_PORT = MANAGED_LOCAL?.port || (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : DEFAULT_LOCAL_PORT);
const LOCAL_URI = classicMartManagedMongoUri(LOCAL_PORT);
const DIRECT_URI = `mongodb://127.0.0.1:${LOCAL_PORT}/admin?directConnection=true`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlaceholder(uri) {
  return !uri || /USERNAME|PASSWORD|CLUSTER_HOST|YOUR_CLUSTER/i.test(uri);
}


function upsertEnv(key, value) {
  const source = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const next = upsertUniqueEnvValue(source, key, value);
  fs.writeFileSync(ENV_FILE, next, { encoding: 'utf8', mode: 0o600 });
}

async function topology(uri, direct = false) {
  let connection;
  try {
    connection = await mongoose.createConnection(uri, {
      autoIndex: false,
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 1_500,
      socketTimeoutMS: 3_000,
      directConnection: direct || undefined,
    }).asPromise();
    return await connection.db.admin().command({ hello: 1 });
  } catch {
    return null;
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}

function executableFromPath(name) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  return String(result.stdout || '').split(/\r?\n/).map((row) => row.trim()).find(Boolean) || '';
}

function scanWindowsMongo() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map((base) => path.join(base, 'MongoDB', 'Server'));
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const exe = path.join(root, version, 'bin', 'mongod.exe');
      if (fs.existsSync(exe)) candidates.push({ version, exe });
    }
  }
  return candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })).map((row) => row.exe)[0] || '';
}

function findMongod() {
  return executableFromPath(process.platform === 'win32' ? 'mongod.exe' : 'mongod') || (process.platform === 'win32' ? scanWindowsMongo() : '');
}

function installMongoOnWindows() {
  const winget = executableFromPath('winget.exe') || executableFromPath('winget');
  if (!winget) {
    throw new Error('MongoDB Server is not installed and Windows Package Manager (winget) is unavailable. Install MongoDB Community Server once, then rerun `npm run verify:local`.');
  }
  console.log('MongoDB Server is not installed. Installing MongoDB Community Server with Windows Package Manager...');
  const result = spawnSync(winget, [
    'install', '-e', '--id', 'MongoDB.Server', '--accept-package-agreements', '--accept-source-agreements', '--silent',
  ], { stdio: 'inherit', windowsHide: false });
  if (result.status !== 0) {
    throw new Error('Automatic MongoDB Community Server installation failed. Install package MongoDB.Server with winget, then rerun `npm run verify:local`.');
  }
}

function ensureLocalFolders() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function startMongod(mongod) {
  ensureLocalFolders();
  const args = [
    '--dbpath', DB_DIR,
    '--port', String(LOCAL_PORT),
    '--bind_ip', '127.0.0.1',
    '--replSet', REPLICA_SET,
    '--logpath', path.join(LOG_DIR, 'mongod.log'),
    '--logappend',
  ];
  const child = spawn(mongod, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
}

async function waitForDirectServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const hello = await topology(DIRECT_URI, true);
    if (hello) return hello;
    await sleep(500);
  }
  throw new Error(`Local MongoDB did not become reachable on 127.0.0.1:${LOCAL_PORT}. Check ${path.join(LOG_DIR, 'mongod.log')}.`);
}

async function initializeReplicaSet() {
  let connection;
  try {
    connection = await mongoose.createConnection(DIRECT_URI, {
      autoIndex: false,
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5_000,
      directConnection: true,
    }).asPromise();
    const hello = await connection.db.admin().command({ hello: 1 });
    if (!hello.setName) {
      try {
        await connection.db.admin().command({
          replSetInitiate: {
            _id: REPLICA_SET,
            members: [{ _id: 0, host: `127.0.0.1:${LOCAL_PORT}` }],
          },
        });
      } catch (error) {
        if (!/already initialized|already initiated/i.test(String(error?.message || ''))) throw error;
      }
    } else if (hello.setName !== REPLICA_SET) {
      throw new Error(`Local MongoDB on port ${LOCAL_PORT} belongs to replica set ${hello.setName}, expected ${REPLICA_SET}. Change CLASSIC_MART_MONGO_PORT or stop that MongoDB instance.`);
    }
  } finally {
    if (connection) await connection.close().catch(() => {});
  }

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const hello = await topology(DIRECT_URI, true);
    if (hello?.setName === REPLICA_SET && hello?.isWritablePrimary) return hello;
    await sleep(500);
  }
  throw new Error(`Local MongoDB replica set ${REPLICA_SET} did not elect a writable primary.`);
}

async function externalUriReady(uri) {
  const hello = await topology(uri);
  return Boolean(hello && (hello.msg === 'isdbgrid' || hello.setName));
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Automatic local MongoDB bootstrap is disabled in production. Configure MONGO_URI with a managed transaction-capable MongoDB deployment.');
  }

  const configured = CONFIGURED_MONGO_URI;
  if (bootstrapConfig.mode === 'external') {
    if (isPlaceholder(configured)) {
      throw new Error('MONGO_MODE=external requires an explicit transaction-capable MONGO_URI.');
    }
    if (await externalUriReady(configured)) {
      console.log('Using explicitly configured transaction-capable external MongoDB deployment.');
      return;
    }
    throw new Error('MONGO_MODE=external is configured, but MONGO_URI is unreachable or does not support transactions. Fix that URI or set MONGO_MODE=local.');
  }

  if (PROCESS_MONGO_URI && !parseClassicMartManagedMongoUri(PROCESS_MONGO_URI) && !ENV_MONGO_VALUES.at(-1)) {
    console.log('Ignoring inherited external MONGO_URI because MONGO_MODE=local. Set MONGO_MODE=external to opt in to an external development database.');
  }

  if (!isPlaceholder(configured)) {
    if (!CONFIGURED_MANAGED_LOCAL) {
      throw new Error('MONGO_MODE=local accepts only Classic Mart managed-local MONGO_URI values. Set MONGO_MODE=external to opt in to an external development database.');
    }
    if (await externalUriReady(configured)) {
      upsertEnv('MONGO_MODE', 'local');
      upsertEnv('MONGO_URI', LOCAL_URI);
      upsertEnv('CLASSIC_MART_MONGO_PORT', String(LOCAL_PORT));
      console.log(`Using Classic Mart managed local MongoDB — replicaSet=${REPLICA_SET}, port=${LOCAL_PORT}.`);
      return;
    }
    console.log(`Classic Mart managed local MongoDB is not reachable on port ${LOCAL_PORT}; restarting it with preserved data...`);
  } else if (SAVED_MANAGED_LOCAL && ENV_MONGO_VALUES.at(-1) && !parseClassicMartManagedMongoUri(ENV_MONGO_VALUES.at(-1))) {
    console.log(`A stale duplicate MONGO_URI was found; recovering Classic Mart managed local MongoDB on port ${LOCAL_PORT} and canonicalizing .env...`);
  }

  const existing = await topology(DIRECT_URI, true);
  if (existing && !existing.setName) {
    throw new Error(`Port ${LOCAL_PORT} is already occupied by a standalone MongoDB process that is not Classic Mart's ${REPLICA_SET} replica set. Stop that process or set CLASSIC_MART_MONGO_PORT to another free port.`);
  }
  if (existing?.setName && existing.setName !== REPLICA_SET) {
    throw new Error(`Port ${LOCAL_PORT} is already occupied by MongoDB replica set ${existing.setName}, not Classic Mart's ${REPLICA_SET}. Set CLASSIC_MART_MONGO_PORT to another free port.`);
  }
  if (!existing) {
    let mongod = findMongod();
    if (!mongod && process.platform === 'win32') {
      installMongoOnWindows();
      mongod = findMongod();
    }
    if (!mongod) {
      throw new Error('MongoDB Server is not installed. Install MongoDB Community Server or configure MONGO_URI with MongoDB Atlas/another replica set.');
    }
    console.log(`Starting Classic Mart local MongoDB replica set on port ${LOCAL_PORT}...`);
    startMongod(mongod);
    await waitForDirectServer();
  }

  await initializeReplicaSet();
  upsertEnv('MONGO_MODE', 'local');
  upsertEnv('MONGO_URI', LOCAL_URI);
  upsertEnv('CLASSIC_MART_MONGO_PORT', String(LOCAL_PORT));
  const refreshedEnv = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  if (!envValues(refreshedEnv, 'REDIS_URL').length) upsertEnv('REDIS_URL', '');
  process.env.MONGO_URI = LOCAL_URI;
  console.log(`Classic Mart local MongoDB ready — replicaSet=${REPLICA_SET}, port=${LOCAL_PORT}.`);
  console.log('MONGO_URI was saved to .env. Docker and Atlas credentials are not required for local development.');
}

await main();
