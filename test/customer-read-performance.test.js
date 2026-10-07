import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { customerRead } from '../src/dashboard/customer-reads.js';
import { assetUrl, isVersionedAsset } from '../src/core/public-assets.js';

test('concurrent customer reads share even null results within one request, never across requests', async () => {
  let executions = 0;
  const loader = async () => { executions++; await new Promise(resolve => setTimeout(resolve, 5)); return null; };
  const first = {};
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => customerRead(first, 'loyalty', loader))), Array(20).fill(null));
  assert.equal(executions, 1);
  await customerRead({}, 'loyalty', loader);
  assert.equal(executions, 2);
});

test('failed customer reads remain failed for the request and retry on a new request', async () => {
  const failure = new Error('Database unavailable');
  let executions = 0;
  const loader = async () => { executions++; throw failure; };
  const first = {};
  await assert.rejects(customerRead(first, 'wallet', loader), failure);
  await assert.rejects(customerRead(first, 'wallet', loader), failure);
  await assert.rejects(customerRead({}, 'wallet', loader), failure);
  assert.equal(executions, 2);
});

test('approved assets use content fingerprints and only matching fingerprints qualify for immutable caching', () => {
  const url = new URL(assetUrl('/approved-dashboard/customer-live.js'), 'http://localhost');
  assert.match(url.searchParams.get('v'), /^[a-f0-9]{16}$/);
  assert.ok(isVersionedAsset(url.pathname, url.searchParams.get('v')));
  assert.equal(isVersionedAsset(url.pathname, 'old-release'), false);
  assert.equal(isVersionedAsset('/account/security', url.searchParams.get('v')), false);
});

test('private route matching bypasses account data without disabling public script caching', () => {
  const context={self:{addEventListener(){}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  for(const path of ['/dashboard','/orders','/orders/receipt','/addresses','/wallet/return','/account/security','/verify-email','/api/v1/cart']) assert.equal(context.isPrivate(path),true,path);
  for(const path of ['/categories-page.js','/profile-page.js','/cart-page.js','/approved-dashboard/customer-live.js','/products/prd_1']) assert.equal(context.isPrivate(path),false,path);
});
