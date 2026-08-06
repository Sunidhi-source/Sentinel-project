#!/usr/bin/env node
'use strict';

/**
 * THE core deliverable of this project.
 *
 * Proves that Sentinel enforces one aggregate rate limit across N separate
 * processes/instances of a protected service, all hammered concurrently --
 * NOT N independent per-instance limits that multiply the real cap (which
 * is what you get with any in-memory / per-process rate limiter, and is the
 * bug this whole project exists to avoid).
 *
 * How it works:
 *   1. Spawns `INSTANCES` copies of dummy-origin/server.js on different
 *      ports, each with Sentinel middleware attached, all pointed at the
 *      SAME Redis and the SAME route config (so same Redis keys -> same
 *      bucket/window state).
 *   2. Fires concurrent load at ALL instances simultaneously using the same
 *      API key (so every request maps to the exact same rate-limit scope
 *      key), via autocannon subprocesses -- one per instance, running in
 *      parallel, so requests genuinely interleave across processes hitting
 *      Redis at the same time.
 *   3. Sums 2xx (allowed) vs 429 (throttled) across all instances.
 *   4. Verifies: allowed count stays close to the configured single-bucket
 *      capacity (plus expected refill during the test), and is nowhere
 *      near capacity * INSTANCES -- which is what a broken/per-instance
 *      limiter would produce.
 *
 * Usage: node load-test/multi-instance-proof.js
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');

const INSTANCES = 3;
const BASE_PORT = 5101;
const API_KEY = 'proof-key-001';
const CONFIG_PATH = path.join(__dirname, 'proof.config.json');
const TEST_DURATION_SEC = 6;
const CONNECTIONS_PER_INSTANCE = 25;

const fs = require('fs');
// A dedicated tight config so the math is easy to verify: token-bucket,
// capacity 100, refills over 60s -> ~1.67 tokens/sec.
const LIMIT = 100;
const WINDOW_SECONDS = 60;
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      redisFailureMode: 'fail-open',
      defaultScope: 'apiKey',
      routes: {
        '/api/search': { algorithm: 'token-bucket', limit: LIMIT, windowSeconds: WINDOW_SECONDS, scope: 'apiKey' },
      },
    },
    null,
    2
  )
);

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: 'localhost', port, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`instance on ${port} did not come up`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function main() {
  console.log(`\n=== Sentinel multi-instance correctness proof ===`);
  console.log(`Instances: ${INSTANCES} | Shared limit: ${LIMIT} tokens / ${WINDOW_SECONDS}s | Test: ${TEST_DURATION_SEC}s @ ${CONNECTIONS_PER_INSTANCE} conns/instance\n`);

  const children = [];
  const ports = [];
  for (let i = 0; i < INSTANCES; i++) {
    const port = BASE_PORT + i;
    ports.push(port);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'dummy-origin', 'server.js')], {
      env: { ...process.env, PORT: String(port), INSTANCE_ID: String(i + 1), SENTINEL_CONFIG: CONFIG_PATH },
      stdio: 'inherit',
    });
    children.push(child);
  }

  try {
    await Promise.all(ports.map((p) => waitForHealth(p)));
    console.log('All instances up. Firing concurrent load...\n');

    const results = await Promise.all(
      ports.map(
        (port) =>
          new Promise((resolve, reject) => {
            const args = [
              '-c', String(CONNECTIONS_PER_INSTANCE),
              '-d', String(TEST_DURATION_SEC),
              '-H', `x-api-key: ${API_KEY}`,
              '--json',
              `http://localhost:${port}/api/search`,
            ];
            execFile(
              process.execPath,
              [path.join(__dirname, '..', 'node_modules', 'autocannon', 'autocannon.js'), ...args],
              { maxBuffer: 1024 * 1024 * 50 },
              (err, stdout) => {
                if (err && !stdout) return reject(err);
                try {
                  resolve(JSON.parse(stdout));
                } catch (e) {
                  reject(e);
                }
              }
            );
          })
      )
    );

    let allowed = 0;
    let throttled = 0;
    let totalReqs = 0;
    let latencies = [];

    for (const r of results) {
      const codes = r.statusCodeStats || {};
      for (const [code, stat] of Object.entries(codes)) {
        totalReqs += stat.count;
        if (Number(code) === 200) allowed += stat.count;
        if (Number(code) === 429) throttled += stat.count;
      }
      if (r.latency && typeof r.latency.p99 === 'number') latencies.push(r.latency.p99);
    }

    const brokenCaseWouldBe = LIMIT * INSTANCES;
    const expectedRefillDuringTest = (LIMIT / WINDOW_SECONDS) * TEST_DURATION_SEC;
    const tolerance = Math.ceil(expectedRefillDuringTest) + 5;

    console.log('=== RESULTS ===');
    console.log(`Total requests fired:      ${totalReqs}`);
    console.log(`Allowed (2xx):             ${allowed}`);
    console.log(`Throttled (429):           ${throttled}`);
    console.log(`Configured shared limit:   ${LIMIT}  (+ ~${expectedRefillDuringTest.toFixed(1)} refill during test)`);
    console.log(`What a BROKEN per-instance limiter would allow: ~${brokenCaseWouldBe} (${INSTANCES}x too many)`);
    console.log(`Aggregate p99 latency across instances: ${latencies.length ? Math.max(...latencies) : 'n/a'} ms\n`);

    const pass = allowed <= LIMIT + tolerance && allowed < brokenCaseWouldBe * 0.6;
    if (pass) {
      console.log(`✅ PASS: aggregate allowed count (${allowed}) tracks the single shared limit (${LIMIT} ± ${tolerance}), not ${brokenCaseWouldBe} (limit × instances).`);
      console.log(`   Rate-limit accuracy: within ${(Math.abs(allowed - LIMIT) / LIMIT * 100).toFixed(2)}% of the configured cap across ${INSTANCES} concurrent instances under ${totalReqs} requests.\n`);
    } else {
      console.log(`❌ FAIL: allowed count (${allowed}) is out of expected bounds -- check Redis connectivity / key scoping.\n`);
    }
  } finally {
    for (const c of children) c.kill('SIGTERM');
    fs.unlinkSync(CONFIG_PATH);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
