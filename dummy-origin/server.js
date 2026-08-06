'use strict';

// A trivial "real" API that Sentinel protects. We run N copies of this on
// different ports to simulate a service running behind a load balancer
// across multiple instances/processes -- the scenario Sentinel has to get
// right (aggregate limit enforced across all instances, not per-instance).
//
//   INSTANCE_ID=1 PORT=5001 node dummy-origin/server.js
//   INSTANCE_ID=2 PORT=5002 node dummy-origin/server.js
//   INSTANCE_ID=3 PORT=5003 node dummy-origin/server.js

const express = require('express');
const path = require('path');
const { sentinelMiddleware } = require('../src/index');

const PORT = Number(process.env.PORT) || 5001;
const INSTANCE_ID = process.env.INSTANCE_ID || String(PORT);
const CONFIG_PATH = process.env.SENTINEL_CONFIG || path.join(__dirname, '..', 'examples', 'sentinel.config.json');

const app = express();

// All instances share the same config -> same Redis keys -> same aggregate
// limit, regardless of which instance a given request lands on.
const sentinel = sentinelMiddleware(CONFIG_PATH);
app.use(sentinel);

app.get('/api/search', (req, res) => {
  res.json({ ok: true, instance: INSTANCE_ID, route: '/api/search', ts: Date.now() });
});

app.get('/health', (req, res) => res.json({ instance: INSTANCE_ID, redisAvailable: sentinel.sentinelRedis.available }));

app.listen(PORT, () => {
  console.log(`[origin instance ${INSTANCE_ID}] listening on http://localhost:${PORT}`);
});
