export const CLASSIC_MART_LOCAL_REPLICA_SET = 'classicmart-rs';
export const CLASSIC_MART_DEFAULT_MONGO_PORT = 27018;

export function parseClassicMartManagedMongoUri(uri) {
  const value = String(uri || '').trim();
  const match = value.match(/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)\/([^?]+)(?:\?(.*))?$/i);
  if (!match) return null;

  const port = Number(match[2]);
  let database = '';
  try {
    database = decodeURIComponent(match[3] || '');
  } catch {
    return null;
  }
  const options = new URLSearchParams(match[4] || '');

  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (database !== 'classic-mart') return null;
  if (options.get('replicaSet') !== CLASSIC_MART_LOCAL_REPLICA_SET) return null;

  return { host: match[1].toLowerCase(), port, database };
}

export function classicMartManagedMongoUri(port = CLASSIC_MART_DEFAULT_MONGO_PORT) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('Classic Mart local MongoDB port is invalid.');
  }
  return `mongodb://127.0.0.1:${parsedPort}/classic-mart?replicaSet=${CLASSIC_MART_LOCAL_REPLICA_SET}`;
}


export function resolveDevelopmentMongoBootstrap({ mode = 'local', envMongoUri = '', processMongoUri = '' } = {}) {
  const normalizedMode = String(mode || 'local').trim().toLowerCase();
  const fromEnv = String(envMongoUri || '').trim();
  const fromProcess = String(processMongoUri || '').trim();

  if (normalizedMode === 'local') {
    const managed = parseClassicMartManagedMongoUri(fromEnv);
    return { mode: 'local', uri: managed ? fromEnv : '' };
  }

  if (normalizedMode === 'external') {
    return { mode: 'external', uri: fromProcess || fromEnv };
  }

  throw new Error('MONGO_MODE must be either local or external in development.');
}
