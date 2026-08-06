#!/usr/bin/env node
'use strict';

/**
 * Measures the p99 latency Sentinel adds per request, by benchmarking the
 * SAME route with and without the middleware attached, at real throughput.
 *
 * Usage: node load-test/run.js
 */

const { execFile } = require('child_process');
const path = require('path');
const express = require('express');
const { sentinelMiddleware } = require('../src/index');

const DURATION_SEC = 8;
const CONNECTIONS = 50;
const PORT_PROTECTED = 6101;
const PORT_BASELINE = 6102;

function startProtected() {
  const app = express();
  app.use(
    sentinelMiddleware({
      redisFailureMode: 'fail-open',
      defaultScope: 'apiKey',
      routes: { '/ping': { algorithm: 'token-bucket', limit: 100000, windowSeconds: 60, scope: 'apiKey' } },
    })
  );
  app.get('/ping', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(PORT_PROTECTED, () => resolve(server));
  });
}

function startBaseline() {
  const app = express();
  app.get('/ping', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(PORT_BASELINE, () => resolve(server));
  });
}

function runAutocannon(port, headers = []) {
  return new Promise((resolve, reject) => {
    const args = ['-c', String(CONNECTIONS), '-d', String(DURATION_SEC), '--json'];
    for (const h of headers) args.push('-H', h);
    args.push(`http://localhost:${port}/ping`);
    execFile(
      process.execPath,
      [path.join(__dirname, '..', 'node_modules', 'autocannon', 'autocannon.js'), ...args],
      { maxBuffer: 1024 * 1024 * 50 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(JSON.parse(stdout));
      }
    );
  });
}

async function main() {
  console.log('Starting protected (Sentinel) and baseline (no middleware) servers...');
  const [protectedServer, baselineServer] = await Promise.all([startProtected(), startBaseline()]);

  await new Promise((r) => setTimeout(r, 300)); // let Sentinel finish connecting to Redis

  console.log(`Benchmarking baseline (no Sentinel) for ${DURATION_SEC}s @ ${CONNECTIONS} conns...`);
  const baseline = await runAutocannon(PORT_BASELINE);

  console.log(`Benchmarking protected (Sentinel + Redis EVALSHA) for ${DURATION_SEC}s @ ${CONNECTIONS} conns...`);
  const protectedResult = await runAutocannon(PORT_PROTECTED, ['x-api-key: bench-key']);

  const overheadP50 = protectedResult.latency.p50 - baseline.latency.p50;
  const overheadP99 = protectedResult.latency.p99 - baseline.latency.p99;

  console.log('\n=== LATENCY OVERHEAD REPORT ===');
  console.log(`Baseline   p50/p99: ${baseline.latency.p50}ms / ${baseline.latency.p99}ms   (${baseline.requests.average.toFixed(0)} req/s avg)`);
  console.log(`Protected  p50/p99: ${protectedResult.latency.p50}ms / ${protectedResult.latency.p99}ms   (${protectedResult.requests.average.toFixed(0)} req/s avg)`);
  console.log(`Sentinel added overhead -> p50: ${overheadP50.toFixed(2)}ms | p99: ${overheadP99.toFixed(2)}ms`);
  console.log(`\nResume bullet: "Added ${Math.max(overheadP99, 0).toFixed(2)}ms p99 overhead at ~${protectedResult.requests.average.toFixed(0)} req/sec under load."\n`);

  protectedServer.close();
  baselineServer.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
