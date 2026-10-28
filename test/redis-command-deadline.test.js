import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { TimeoutError } from 'redis';
import { createRedisConnection } from '../src/config/redis.js';
import { requireRedisCommand, REDIS_COMMAND_TIMEOUT_MS } from '../src/core/redis-command.js';
import { RedisRateLimitStore } from '../src/core/redis-rate-limit-store.js';
import { createRedisSessionStore } from '../src/middleware/session.js';

test('Redis reply deadlines preserve immediate results and failures, and observe late failures without retrying', async () => {
  const value = { accepted: true };
  assert.equal(await requireRedisCommand(() => value), value);
  const failure = new Error('Command rejected');
  await assert.rejects(requireRedisCommand(() => { throw failure; }), error => error === failure);

  let calls = 0, failLate;
  const reply = new Promise((_resolve, reject) => { failLate = reject; });
  const result = requireRedisCommand(() => { calls++; return reply; }, { timeoutMs: 20 });
  await assert.rejects(result, TimeoutError);
  failLate(failure);
  await setImmediate();
  assert.equal(calls, 1, 'A command with an uncertain outcome must never be retried.');
});

// Minimal isolated RESP fixture: it acknowledges the real client's handshake,
// then can keep an established TCP connection open without sending any reply.
async function redisReplyFixture() {
  const sockets = new Set(), commands = [], held = [], values = new Map();
  let stalled = false, connections = 0;
  const bulk = value => value == null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  function respond(socket, args, late = false) {
    const [command, key, value] = args;
    let reply;
    if (late && command === 'GET') reply = '-ERR delayed read failure\r\n';
    else if (command === 'HELLO') reply = '%1\r\n+proto\r\n:3\r\n';
    else if (command === 'CLIENT') reply = '+OK\r\n';
    else if (command === 'PING') reply = '+PONG\r\n';
    else if (command === 'GET') reply = bulk(values.get(key));
    else if (command === 'SET') { values.set(key, value); reply = '+OK\r\n'; }
    else if (command === 'EXPIRE') reply = `:${Number(values.has(key))}\r\n`;
    else if (command === 'DEL') reply = `:${Number(values.delete(key))}\r\n`;
    else if (command === 'EVAL') {
      const counterKey = args[3], previous = Number(values.get(counterKey) || 0);
      const total = key.includes("redis.call('INCR'") ? previous + 1 : Math.max(previous - 1, 0);
      values.set(counterKey, String(total));
      reply = key.includes("redis.call('INCR'") ? `*2\r\n:${total}\r\n:60000\r\n` : `:${total}\r\n`;
    } else throw new Error(`Unexpected fixture command: ${command}`);
    socket.write(reply);
  }
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        assert.equal(buffer[0], 42, 'RESP command must start with an array.');
        const count = Number(buffer.toString('ascii', 1, lineEnd));
        let offset = lineEnd + 2;
        const args = [];
        for (let index = 0; index < count; index++) {
          const end = buffer.indexOf('\r\n', offset);
          if (end < 0) return;
          assert.equal(buffer[offset], 36, 'RESP command arguments must be bulk strings.');
          const size = Number(buffer.toString('ascii', offset + 1, end));
          if (buffer.length < end + 2 + size + 2) return;
          args.push(buffer.toString('utf8', end + 2, end + 2 + size));
          offset = end + 2 + size + 2;
        }
        buffer = buffer.subarray(offset);
        commands.push(args);
        if (stalled) held.push([socket, args]);
        else respond(socket, args);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `redis://127.0.0.1:${server.address().port}`, commands, values,
    get connections() { return connections; },
    stall() { stalled = true; },
    resume() {
      stalled = false;
      for (const [socket, args] of held.splice(0)) respond(socket, args, true);
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

test('an established Redis that stops replying bounds every session and limiter operation, then accepts late replies without retries',
  { timeout: 15_000 }, async () => {
    const fixture = await redisReplyFixture();
    const connection = createRedisConnection({ url: fixture.url, production: true, log: { info() {}, warn() {} } });
    try {
      const client = await connection.get();
      const store = createRedisSessionStore(client);
      const limiter = new RedisRateLimitStore({ scope: 'test:reply-deadline', getClient: () => connection.get() });
      limiter.init({ windowMs: 60_000 });
      let resolveClient;
      const delayedClient = new Promise(resolve => { resolveClient = resolve; });
      const waitingLimiter = new RedisRateLimitStore({ scope: 'test:late-client', getClient: () => delayedClient });
      waitingLimiter.init({ windowMs: 60_000 });
      const callback = (method, ...args) => new Promise((resolve, reject) => {
        store[method](...args, (error, value) => error ? reject(error) : resolve(value));
      });
      const state = { cookie: { maxAge: 60_000, expires: new Date(Date.now() + 60_000) }, userId: 'owned-session' };
      await callback('set', 'existing', state);
      assert.equal((await callback('get', 'existing')).userId, state.userId);
      const started = performance.now(), countBefore = fixture.commands.length;
      fixture.stall();
      const results = await Promise.allSettled([
        callback('get', 'existing'), callback('set', 'late-write', state),
        callback('touch', 'existing', state), callback('destroy', 'other-session'),
        limiter.increment('actor'), limiter.decrement('other-actor'), limiter.resetKey('other-counter'),
        waitingLimiter.increment('late-client'),
      ]);
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= REDIS_COMMAND_TIMEOUT_MS - 100 && elapsed < 8_000, `Replies settled after ${elapsed}ms.`);
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.ok(result.reason instanceof TimeoutError);
      }
      resolveClient(client);
      await setImmediate();
      assert.equal(fixture.commands.length - countBefore, 7, 'All commands reached the open TCP connection exactly once.');
      assert.equal(fixture.commands.filter(args => args[3] === waitingLimiter.key('late-client')).length, 0,
        'Client lookup completing after its deadline must not dispatch a new mutation.');
      assert.equal(client.isReady, true, 'A reply deadline does not close a healthy idle connection.');
      assert.equal(await connection.get(), client);
      assert.equal(fixture.connections, 1);

      fixture.resume();
      assert.equal(await client.ping(), 'PONG', 'Late failures/replies must be consumed without corrupting the connection.');
      assert.equal((await callback('get', 'late-write')).userId, state.userId);
      assert.equal((await limiter.increment('actor')).totalHits, 2, 'The uncertain timed-out increment was never retried.');
      assert.equal(fixture.commands.filter(args => args[0] === 'SET' && args[1].endsWith('late-write')).length, 1);
      assert.equal(fixture.connections, 1, 'The session adapter and limiter keep the shared original client.');
    } finally {
      await connection.disconnect();
      await fixture.close();
    }
  });
