'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SentinelRedis } = require('../src/redisClient');
const { checkLimit } = require('../src/limiter');

async function withRedis(fn) {
  const r = new SentinelRedis({ redis: { host: '127.0.0.1', port: 6379 } });
  await r.connect();
  assert.ok(r.available, 'Redis must be reachable for these tests');
  try {
    await fn(r);
  } finally {
    await r.quit();
  }
}

test('token-bucket: allows up to capacity, then blocks', async () => {
  await withRedis(async (r) => {
    const rule = { algorithm: 'token-bucket', limit: 5, windowSeconds: 10, ttlSeconds: 30 };
    const routePattern = `/test/tb-${Date.now()}`;
    const scopeKey = 'apiKey:test';
    let allowedCount = 0;
    for (let i = 0; i < 8; i++) {
      const res = await checkLimit(r, { routePattern, scopeKey, rule, nowMs: Date.now() });
      if (res.allowed) allowedCount++;
    }
    assert.strictEqual(allowedCount, 5, `expected exactly 5 allowed, got ${allowedCount}`);
  });
});

test('sliding-window-log: exact count enforcement within window', async () => {
  await withRedis(async (r) => {
    const rule = { algorithm: 'sliding-window-log', limit: 3, windowSeconds: 5, ttlSeconds: 30 };
    const routePattern = `/test/swl-${Date.now()}`;
    const scopeKey = 'ip:1.2.3.4';
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push((await checkLimit(r, { routePattern, scopeKey, rule, nowMs: Date.now() })).allowed);
    }
    const allowedCount = results.filter(Boolean).length;
    assert.strictEqual(allowedCount, 3, `expected exactly 3 allowed, got ${allowedCount}`);
  });
});

test('sliding-window-counter: blocks once estimated count exceeds limit', async () => {
  await withRedis(async (r) => {
    const rule = { algorithm: 'sliding-window-counter', limit: 4, windowSeconds: 5, ttlSeconds: 30 };
    const routePattern = `/test/swc-${Date.now()}`;
    const scopeKey = 'userId:u1';
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      const res = await checkLimit(r, { routePattern, scopeKey, rule, nowMs: Date.now() });
      if (res.allowed) allowedCount++;
    }
    // Sliding window counter is an approximation; with zero elapsed time in
    // the previous window it behaves like a fixed window counter here.
    assert.strictEqual(allowedCount, 4, `expected exactly 4 allowed, got ${allowedCount}`);
  });
});

test('concurrent requests never exceed the limit (race condition check)', async () => {
  await withRedis(async (r) => {
    const rule = { algorithm: 'token-bucket', limit: 10, windowSeconds: 60, ttlSeconds: 30 };
    const routePattern = `/test/race-${Date.now()}`;
    const scopeKey = 'ip:race-test';
    const now = Date.now();
    // Fire 50 concurrent requests at a bucket with capacity 10. If the
    // check-and-decrement weren't atomic, more than 10 would get through.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkLimit(r, { routePattern, scopeKey, rule, nowMs: now }))
    );
    const allowedCount = results.filter((x) => x.allowed).length;
    assert.strictEqual(allowedCount, 10, `expected exactly 10 allowed under concurrency, got ${allowedCount}`);
  });
});
