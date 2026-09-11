import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envLastValue } from './env-file.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = path.join(root, '.env');

export function projectEnvSource() {
  return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
}

export function projectMongoMode({ nodeEnv = process.env.NODE_ENV, source = projectEnvSource() } = {}) {
  if (String(nodeEnv || '').trim().toLowerCase() === 'production') return 'external';
  return String(envLastValue(source, 'MONGO_MODE') || process.env.MONGO_MODE || 'external').trim().toLowerCase();
}

export function projectMongoUri({ nodeEnv = process.env.NODE_ENV, source = projectEnvSource() } = {}) {
  const fileValue = String(envLastValue(source, 'MONGO_URI') || '').trim();
  const processValue = String(process.env.MONGO_URI || '').trim();
  const normalizedEnv = String(nodeEnv || '').trim().toLowerCase();
  if (normalizedEnv === 'production') return processValue || fileValue;
  if (normalizedEnv === 'test') {
    return process.env.CLASSIC_MART_TEST_MONGO_OVERRIDE === '1' ? (processValue || fileValue) : '';
  }
  return projectMongoMode({ nodeEnv, source }) === 'local' ? fileValue : (processValue || fileValue);
}

export function projectAuditMongoUri({ nodeEnv = process.env.NODE_ENV, source = projectEnvSource() } = {}) {
  const fileValue = String(envLastValue(source, 'AUDIT_MONGO_URI') || '').trim();
  const processValue = String(process.env.AUDIT_MONGO_URI || '').trim();
  const normalizedEnv = String(nodeEnv || '').trim().toLowerCase();
  if (normalizedEnv === 'production') return processValue || fileValue;
  if (normalizedEnv === 'test') {
    return process.env.CLASSIC_MART_TEST_MONGO_OVERRIDE === '1' ? (processValue || fileValue) : '';
  }
  return projectMongoMode({ nodeEnv, source }) === 'local' ? fileValue : (processValue || fileValue);
}

export function projectMongoPort({ source = projectEnvSource(), fallback = 27018 } = {}) {
  const fileValue = envLastValue(source, 'CLASSIC_MART_MONGO_PORT');
  const candidate = fileValue || process.env.CLASSIC_MART_MONGO_PORT || '';
  const port = Number.parseInt(candidate, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
