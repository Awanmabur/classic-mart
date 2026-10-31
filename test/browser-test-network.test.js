import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBrowserTestNetwork } from '../scripts/browser-test-network.js';

async function environment(values, work) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try { return await work(); }
  finally { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; }
}
const isolated = work => environment({ NODE_ENV: 'test', CLASSIC_MART_E2E_LOOPBACK_ISOLATION: '1' }, work);
async function listening(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  });
}
function request(baseURL, { pathname = '/', method = 'GET', headers = {}, body = Buffer.alloc(0) } = {}) {
  const target = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const call = http.request({ hostname: target.hostname, port: target.port, path: pathname, method,
      headers: { ...headers, 'content-length': body.length }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject); call.end(body);
  });
}
function within(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned browser network did not close its active upstream.')), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test('browser tests have distinct actual TCP peers while each test retains its identity and HTTP data', async () => isolated(async () => {
  const cookies = ['first=one; Path=/; HttpOnly', 'second=two%20words; SameSite=Lax'];
  const server = http.createServer(async (incoming, response) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    response.writeHead(207, { 'content-type': 'application/json', 'set-cookie': cookies });
    response.end(JSON.stringify({ peer: incoming.socket.remoteAddress, host: incoming.headers.host,
      method: incoming.method, path: incoming.url, cookie: incoming.headers.cookie,
      forwardedFor: incoming.headers['x-forwarded-for'] || null, forwarded: incoming.headers.forwarded || null,
      body: Buffer.concat(chunks).toString('base64') }));
  });
  const baseURL = await listening(server), networks = [];
  try {
    for (const [workerIndex, sequence] of [[0, 1], [0, 2], [1, 1], [0, 256]]) {
      networks.push(await createBrowserTestNetwork({ baseURL, workerIndex, sequence }));
    }
    const body = Buffer.from([0, 1, 255, 120]), seen = [];
    for (const network of networks) {
      const peers = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await request(network.baseURL, { method: 'POST', pathname: '/encoded%2Fpath?q=a%2Bb&item=1&item=2', body,
          headers: { host: 'original-browser.test:3210', cookie: 'sid=owned-session; choice=two%20words' } });
        assert.equal(result.status, 207); assert.deepEqual(result.headers['set-cookie'], cookies);
        const observed = JSON.parse(result.body);
        assert.equal(observed.method, 'POST'); assert.equal(observed.host, 'original-browser.test:3210');
        assert.equal(observed.path, '/encoded%2Fpath?q=a%2Bb&item=1&item=2');
        assert.equal(observed.cookie, 'sid=owned-session; choice=two%20words');
        assert.equal(observed.body, body.toString('base64'));
        assert.equal(observed.forwardedFor, null); assert.equal(observed.forwarded, null);
        peers.push(observed.peer);
      }
      assert.equal(new Set(peers).size, 1, 'one test must keep the same physical network identity');
      assert.equal(network.requestCount, 3); seen.push(peers[0]);
    }
    assert.deepEqual(seen, ['127.1.0.1', '127.1.0.2', '127.2.0.1', '127.1.1.0']);
    assert.equal(new Set(seen).size, networks.length, 'different tests and workers must have different TCP peers');
  } finally {
    await Promise.all(networks.map(network => network.close())); await close(server);
  }
}));

test('browser network teardown closes held requests and remains idempotent without stopping the target', async () => isolated(async () => {
  let upstreamClosed;
  const ended = new Promise(resolve => { upstreamClosed = resolve; });
  const server = http.createServer((incoming, response) => {
    if (incoming.url === '/pending') {
      response.on('close', upstreamClosed); response.writeHead(200); response.write('started');
    } else response.end('target still running');
  });
  const baseURL = await listening(server), network = await createBrowserTestNetwork({ baseURL, workerIndex: 0, sequence: 3 });
  let call;
  try {
    await new Promise((resolve, reject) => {
      call = http.get(network.baseURL + '/pending', response => {
        response.on('error', () => {}); response.once('data', resolve);
      });
      call.on('error', reject);
    });
    await within(network.close(), 1500); await within(ended, 1500); await network.close();
    const result = await request(baseURL);
    assert.equal(result.status, 200); assert.equal(result.body.toString(), 'target still running');
  } finally {
    call?.destroy(); await close(server); await network.close();
  }
}));

test('browser network isolation refuses production and requires its explicit test flag', async () => {
  const options = { baseURL: 'http://127.0.0.1:1', workerIndex: 0, sequence: 1 };
  await environment({ NODE_ENV: 'production', CLASSIC_MART_E2E_LOOPBACK_ISOLATION: '1' }, async () => {
    await assert.rejects(createBrowserTestNetwork(options), /NODE_ENV=test/);
  });
  await environment({ NODE_ENV: 'test', CLASSIC_MART_E2E_LOOPBACK_ISOLATION: '' }, async () => {
    await assert.rejects(createBrowserTestNetwork(options), /explicitly/);
  });
});

test('browser isolation cannot target external services or silently wrap its address allocation', async () => isolated(async () => {
  const options = { workerIndex: 0, sequence: 1 };
  for (const baseURL of ['https://127.0.0.1:1', 'http://example.test:1', 'http://192.168.1.1:1',
    'http://127.0.0.1.example.test:1', 'http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/path',
    'http://127.0.0.1:1/?query=value', 'http://127.0.0.1:1/#fragment']) {
    await assert.rejects(createBrowserTestNetwork({ ...options, baseURL }));
  }
  for (const workerIndex of [-1, 254, 0.5, Number.NaN]) {
    await assert.rejects(createBrowserTestNetwork({ baseURL: 'http://127.0.0.1:1', workerIndex, sequence: 1 }), /workerIndex/);
  }
  for (const sequence of [0, 65536, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(createBrowserTestNetwork({ baseURL: 'http://127.0.0.1:1', workerIndex: 0, sequence }), /sequence/);
  }
}));
