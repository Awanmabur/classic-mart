import fs from 'node:fs';
import path from 'node:path';

const sharedRuntimeScripts = Object.freeze({
  worker: 'node src/worker.js',
  'bootstrap:production': 'node scripts/bootstrap-production.js',
  'production:data-check': 'node scripts/check-production-data.js',
  'migrate:plan': 'node scripts/migrate-production.js',
  'migrate:apply': 'node scripts/migrate-production.js --apply',
  'pesapal:register-ipn': 'node scripts/pesapal-register-ipn.js',
  'launch:check': 'node scripts/launch-check.js',
  'deploy:smoke': 'node scripts/deploy-smoke.js',
  'backup:drill': 'node scripts/backup-drill.js',
  'media:r2:check': 'node scripts/check-r2.js',
  'mail:verify': 'node scripts/verify-mail.js',
  'sms:verify': 'node scripts/verify-sms.js',
  'launch:evidence': 'node scripts/launch-evidence.js',
  'staff:access': 'node scripts/staff-access.js',
});

export const productionRuntimeScripts = Object.freeze({
  start: 'node scripts/run-production.js',
  ...sharedRuntimeScripts,
});

export const cleanRuntimeScripts = Object.freeze({
  dev: 'node src/server.js',
  'dev:watch': 'node --watch src/server.js',
  start: 'node src/server.js',
  ...sharedRuntimeScripts,
  'db:verify': 'node scripts/verify-mongo.js',
  'seed:initial': 'node scripts/seed-initial-catalogue.js',
  'setup:external': 'npm run db:verify && npm run media:r2:check && npm run seed:initial',
  'db:setup': 'npm run setup:external',
  'db:seed': 'npm run seed:initial',
  'admin:reset-password': 'node scripts/reset-admin-password.js',
  'start:production': 'node scripts/run-production.js',
});

// Build support for release archives and images. The final Docker image excludes
// this helper, and runtime script maps exclude source-only engineering commands.
export function rewriteRuntimePackage(directory, kind) {
  if (kind !== 'production' && kind !== 'clean') {
    throw new TypeError('Runtime package kind must be production or clean.');
  }
  const packagePath = path.join(directory, 'package.json');
  const lockPath = path.join(directory, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  delete pkg.devDependencies;
  pkg.scripts = { ...(kind === 'production' ? productionRuntimeScripts : cleanRuntimeScripts) };
  if (lock.packages?.['']) delete lock.packages[''].devDependencies;

  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
