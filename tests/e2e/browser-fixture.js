import assert from 'node:assert/strict';
import { test as originalTest, expect } from '@playwright/test';
import { createBrowserTestNetwork } from '../../scripts/browser-test-network.js';

let sequence = 0;
const active = new WeakMap();
export const test = process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION === '1' ? originalTest.extend({
  // Keep this a bare override: the inherited fixture supplies config.use.baseURL.
  // Re-registering it as an option tuple would let config replace this wrapper.
  baseURL: async ({ baseURL }, use, testInfo) => {
    const network = await createBrowserTestNetwork({ baseURL, workerIndex: testInfo.workerIndex, sequence: ++sequence });
    active.set(testInfo, network);
    try { await use(network.baseURL); }
    finally { active.delete(testInfo); await network.close(); }
  },
  verifyLoopbackIsolation: [async ({ baseURL }, use, testInfo) => {
    const network = active.get(testInfo);
    assert.ok(network && baseURL === network.baseURL, 'Explicit browser isolation must use its own per-test TCP forwarder.');
    const annotation = { type: 'test-loopback-network', description: network.sourceAddress };
    testInfo.annotations.push(annotation);
    try { await use(); }
    finally { annotation.description += `; ${network.requestCount} upstream requests`; }
  }, { auto: true }],
}) : originalTest;
export { expect };
