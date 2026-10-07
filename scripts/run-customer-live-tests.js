import { spawnSync } from 'node:child_process';

const required = ['CLASSIC_MART_LIVE_BASE_URL', 'CLASSIC_MART_VERIFIED_BASE_URL', 'CLASSIC_MART_LIVE_TEST_MONGO_URI'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error('Live customer verification needs running development servers and an isolated replica-set database.');
  console.error('Missing settings: ' + missing.join(', '));
  process.exit(1);
}
for (const name of required) {
  if (new URL(process.env[name]).hostname !== '127.0.0.1') {
    console.error(name + ' must target the isolated local verification environment.');
    process.exit(1);
  }
}
if (!/verification|test/i.test(new URL(process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI).pathname)) {
  console.error('The database name must identify an isolated test database.');
  process.exit(1);
}
const files = ['identity-live', 'customer-live', 'cart-live', 'gift-card-live', 'customer-browser-live', 'verification-security-live', 'order-filters-live'].map(name => `test/${name}.test.js`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
