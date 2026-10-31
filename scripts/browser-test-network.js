import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

/** Give one browser test a stable real TCP peer without changing app limits. */
export async function createBrowserTestNetwork({ baseURL, workerIndex, sequence }) {
  assert.equal(process.env.NODE_ENV, 'test', 'Browser network isolation requires NODE_ENV=test.');
  assert.equal(process.env.CLASSIC_MART_E2E_LOOPBACK_ISOLATION, '1', 'Enable browser loopback isolation explicitly.');
  const target = new URL(baseURL);
  assert.equal(target.protocol, 'http:', 'Browser isolation requires an HTTP loopback target.');
  assert.ok(target.hostname === 'localhost' || net.isIP(target.hostname) === 4 && target.hostname.startsWith('127.'),
    'Browser isolation requires an IPv4 loopback target.');
  assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
    'Use a root loopback base URL without credentials, query or fragment.');
  assert.ok(Number.isInteger(workerIndex) && workerIndex >= 0 && workerIndex <= 253, 'Browser workerIndex must be between 0 and 253.');
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 65535, 'Browser test sequence must be between 1 and 65535.');
  const sourceAddress = `127.${workerIndex + 1}.${sequence >> 8}.${sequence & 255}`;
  const upstreams = new Set(), sockets = new Set();
  let stopping = false, closed, requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount++;
    const upstream = http.request({ hostname: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
      port: target.port || 80, localAddress: sourceAddress, method: request.method, path: request.url,
      headers: request.headers, agent: false }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => {
      if (response.destroyed) return;
      if (stopping || response.headersSent) response.destroy();
      else { response.writeHead(502); response.end('Browser test upstream unavailable.'); }
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    sourceAddress,
    get requestCount() { return requestCount; },
    close() {
      if (closed) return closed;
      stopping = true;
      closed = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const upstream of upstreams) upstream.destroy();
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}
