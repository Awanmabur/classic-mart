import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createClient, ClientOfflineError } from 'redis';
import { createRedisSessionStore } from '../src/middleware/session.js';
import { createRedisConnection } from '../src/config/redis.js';
import { RedisRateLimitStore } from '../src/core/redis-rate-limit-store.js';

const capture = () => {
  const records = [];
  return { records, log: { info: (...args) => records.push(['info', ...args]), warn: (...args) => records.push(['warn', ...args]) } };
};
const waitFor = async (predicate, message, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});

test('initial Redis retries produce one development fallback diagnostic and a bounded cooldown', async () => {
  const { records, log } = capture();
  let calls = 0, now = 100, options;
  const failure = new Error('Redis connection refused');
  const connection = createRedisConnection({ url: 'redis://127.0.0.1:1', log, now: () => now,
    makeClient(settings) {
      calls++; options = settings;
      const client = new EventEmitter();
      client.connect = async () => { for (let index = 0; index < 8; index++) client.emit('error', failure); throw failure; };
      return client;
    } });
  assert.equal(await connection.get(), null);
  assert.equal(calls, 1);
  assert.equal(records.filter(row => row[0] === 'warn').length, 1);
  assert.match(records[0].at(-1), /development sessions will use MongoDB/);
  assert.equal(options.disableOfflineQueue, true);
  assert.equal(options.commandsQueueMaxLength, 1000);
  assert.equal(options.commandOptions.timeout, 5000);
  assert.equal(options.pingInterval, 15_000);
  assert.equal(options.socket.socketTimeout, undefined, 'Healthy idle connections must not be timed out.');
  assert.equal(options.socket.reconnectStrategy(0), false);
  for (let index = 0; index < 10; index++) assert.equal(await connection.get(), null);
  assert.equal(calls, 1, 'Requests must not start a new failed connection on every attempt.');
  now += 30_001;
  assert.equal(await connection.get(), null);
  assert.equal(calls, 2);
  assert.equal(records.filter(row => row[0] === 'warn').length, 1, 'The same outage is still one event.');
  await connection.disconnect();
});

test('production startup rejects unavailable Redis instead of choosing a fallback store', async () => {
  const { records, log } = capture();
  const failure = new Error('Unavailable Redis');
  let options;
  const connection = createRedisConnection({ url: 'redis://127.0.0.1:1', production: true, log,
    makeClient(settings) {
      options = settings;
      const client = new EventEmitter();
      client.connect = async () => { client.emit('error', failure); throw failure; };
      return client;
    } });
  await assert.rejects(connection.get(), error => error === failure);
  assert.equal(connection.isReady(), false);
  assert.equal(records.length, 0, 'The caller emits the single fatal startup diagnostic.');
  assert.equal(options.socket.reconnectStrategy(6), false);
  assert.ok(options.socket.reconnectStrategy(5) <= 5000);
  await connection.disconnect();
});

test('a real refused development TCP connection settles once without an offline queue or repeated warnings', { timeout: 10_000 }, async () => {
  const unused = net.createServer();
  const port = await listen(unused);
  await new Promise(resolve => unused.close(resolve));
  const { records, log } = capture();
  const connection = createRedisConnection({ url: `redis://127.0.0.1:${port}`, log });
  try {
    assert.equal(await connection.get(), null);
    assert.equal(await connection.get(), null);
    assert.equal(connection.isReady(), false);
    assert.equal(records.filter(row => row[0] === 'warn').length, 1);
  } finally { await connection.disconnect(); }
});

test('Redis PING keepalive preserves a quiet connection beyond a real TCP idle cutoff without replacing the client',
  { timeout: 10_000 }, async () => {
    // Scale both production timings by 50 so the actual client and TCP idle
    // timer exercise multiple PINGs without adding a minute to the test suite.
    const scale = 50, idleCutoffMs = 30_000 / scale;
    const sockets = new Set();
    let accepted = 0, idleDisconnects = 0, pings = 0;
    const server = net.createServer(socket => {
      accepted++;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.setTimeout(idleCutoffMs, () => { idleDisconnects++; socket.destroy(); });
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('ascii');
        for (;;) {
          const lineEnd = buffer.indexOf('\r\n');
          if (lineEnd < 0) return;
          const count = Number(buffer.slice(1, lineEnd));
          let offset = lineEnd + 2;
          const args = [];
          for (let index = 0; index < count; index++) {
            const end = buffer.indexOf('\r\n', offset);
            if (end < 0) return;
            const size = Number(buffer.slice(offset + 1, end));
            if (buffer.length < end + 2 + size + 2) return;
            args.push(buffer.slice(end + 2, end + 2 + size));
            offset = end + 2 + size + 2;
          }
          buffer = buffer.slice(offset);
          if (args[0] === 'HELLO') socket.write('%1\r\n+proto\r\n:3\r\n');
          else if (args[0] === 'PING') { pings++; socket.write('+PONG\r\n'); }
          else socket.write('+OK\r\n');
        }
      });
    });
    const port = await listen(server), url = `redis://127.0.0.1:${port}`;
    const control = createClient({ url, socket: { reconnectStrategy: false } });
    control.on('error', () => {});
    const { records, log } = capture();
    let clients = 0;
    const connection = createRedisConnection({ url, production: true, log,
      makeClient(options) {
        clients++;
        assert.equal(options.pingInterval, 15_000);
        return createClient({ ...options, pingInterval: options.pingInterval / scale });
      } });
    try {
      await control.connect();
      await waitFor(() => !control.isReady, 'An unprotected quiet connection must reach the fixture idle cutoff.');
      assert.equal(idleDisconnects, 1);
      const client = await connection.get();
      await waitFor(() => pings >= 3, 'The client must send repeated PINGs while application requests are idle.');
      assert.equal(client.isReady, true);
      assert.equal(await connection.get(), client);
      assert.equal(idleDisconnects, 1, 'Heartbeat traffic must keep the protected connection open past the same cutoff.');
      assert.equal(clients, 1);
      assert.equal(accepted, 2, 'Only the control and original shared client may connect.');
      assert.equal(records.filter(row => row[0] === 'warn').length, 0);
    } finally {
      if (control.isOpen) control.destroy();
      await connection.disconnect();
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  });

const uri = process.env.CLASSIC_MART_LIVE_TEST_REDIS_URL;
test('an established Redis outage preserves the real session client, blocks every session callback and rate counter, then recovers without resetting data',
  { skip: !uri, timeout: 30_000 }, async () => {
    const target = new URL(uri);
    assert.equal(target.protocol, 'redis:');
    assert.equal(target.hostname, '127.0.0.1');
    const suffix = crypto.randomBytes(12).toString('hex');
    const { records, log } = capture();
    const sockets = new Set();
    const forward = () => net.createServer(downstream => {
      const upstream = net.connect({ host: '127.0.0.1', port: Number(target.port || 6379) });
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { downstream.destroy(); upstream.destroy(); });
      }
      downstream.pipe(upstream).pipe(downstream);
    });
    let server = forward();
    const port = await listen(server);
    const stop = async () => {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    };
    const proxyUrl = new URL(uri); proxyUrl.port = String(port);
    let clients = 0;
    const connection = createRedisConnection({ url: proxyUrl.href, production: true, log,
      makeClient(options) { clients++; return createClient(options); } });
    let client, store, limiter;
    const callback = (method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
    const sid = `identity-${suffix}`, state = { cookie: { maxAge: 60_000, expires: new Date(Date.now() + 60_000) }, userId: 'owned-session-fixture' };
    try {
      client = await connection.get();
      store = createRedisSessionStore(client);
      limiter = new RedisRateLimitStore({ scope: `test:outage:${suffix}`, getClient: () => connection.get() });
      limiter.init({ windowMs: 60_000 });
      await callback('set', sid, state);
      assert.equal((await callback('get', sid)).userId, state.userId);
      assert.equal((await limiter.increment('actor')).totalHits, 1);

      await stop();
      await waitFor(() => !connection.isReady(), 'Redis must stop reporting ready after the real connection is dropped.');
      assert.equal(await connection.get(), client, 'RedisStore and rate limiting must keep their original client.');
      for (const [method, args] of [['get', [sid]], ['set', [sid, state]], ['touch', [sid, state]], ['destroy', [sid]]]) {
        await assert.rejects(callback(method, ...args), ClientOfflineError, `Offline ${method} must fail instead of queueing work.`);
      }
      await assert.rejects(limiter.increment('actor'), error => error.code === 'RATE_LIMIT_STORE_UNAVAILABLE');
      assert.equal(clients, 1, 'The rate limiter cannot replace the session store client during recovery.');
      assert.equal(records.filter(row => row[0] === 'warn').length, 1);

      server = forward(); await listen(server, port);
      await waitFor(() => connection.isReady(), 'The original client must reconnect to the restored dependency.');
      assert.equal(await connection.get(), client);
      assert.equal((await callback('get', sid)).userId, state.userId, 'The outage must not erase the stored session.');
      assert.equal((await limiter.increment('actor')).totalHits, 2, 'The shared security counter must survive recovery.');
      assert.equal(records.filter(row => row.at(-1) === 'Redis connection restored').length, 1);
      assert.equal(clients, 1);
    } finally {
      if (client?.isReady) {
        if (store) await callback('destroy', sid);
        if (limiter) await client.del(limiter.key('actor'));
      }
      await connection.disconnect();
      if (server.listening) await stop();
      for (const socket of sockets) socket.destroy();
    }
  });
