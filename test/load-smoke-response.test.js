import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('launch load smoke measures the whole response and counts an interrupted body once', { timeout: 15_000 }, async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
    response.flushHeaders();
    setTimeout(() => request.url === '/categories' ? response.destroy() : response.end('ok'), 150);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['scripts/load-smoke.js'], { cwd: new URL('../', import.meta.url),
      env: { ...process.env, LOAD_TEST_URL: `http://127.0.0.1:${server.address().port}`, LOAD_TEST_CONCURRENCY: '1',
        LOAD_TEST_REQUESTS: '5', LOAD_TEST_MAX_P95_MS: '100', LOAD_TEST_MAX_ERROR_RATE: '0.01' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.requests, 5);
    assert.ok(result.p50Ms >= 140, 'Receiving headers is not completion of a page response.');
    assert.ok(result.p95Ms >= 140);
    assert.equal(result.errorRate, 0.2);
    assert.deepEqual(result.statuses, { '200': 4, network_error: 1 });
    assert.match(stderr, /Load smoke gate failed/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
