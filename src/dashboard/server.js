'use strict';

require('dotenv').config();

// Standalone demo server: mounts Sentinel in front of a couple of fake
// routes AND serves its own dashboard, all in one process. Useful for
// trying Sentinel out with zero other services running.
//
//   node src/dashboard/server.js

const express = require('express');
const http = require('http');
const path = require('path');
const { sentinelMiddleware } = require('../index');
const { sentinelDashboardRouter, attachStream } = require('./router');

const app = express();

const sentinel = sentinelMiddleware({
  // Only hardcode host/port when REDIS_HOST is explicitly set. Otherwise
  // leave redis unset here so config.js's own default kicks in, which
  // prefers REDIS_URL (Render Key Value / Redis Cloud) when present and
  // only falls back to 127.0.0.1 for plain local Redis.
  ...(process.env.REDIS_HOST
    ? { redis: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) || 6379 } }
    : {}),
  redisFailureMode: 'fail-open',
  defaultScope: 'ip',
  routes: {
    '/api/search': { algorithm: 'token-bucket', limit: 20, windowSeconds: 10, scope: 'ip' },
    '/api/upload': { algorithm: 'sliding-window-counter', limit: 5, windowSeconds: 30, scope: 'ip' },
    '/api/precise': { algorithm: 'sliding-window-log', limit: 10, windowSeconds: 10, scope: 'ip' },
  },
});

app.use('/sentinel', sentinelDashboardRouter(sentinel));
app.use(sentinel);

app.get('/api/search', (req, res) => res.json({ ok: true, route: '/api/search' }));
app.get('/api/upload', (req, res) => res.json({ ok: true, route: '/api/upload' }));
app.get('/api/precise', (req, res) => res.json({ ok: true, route: '/api/precise' }));
app.get('/health', (req, res) => res.json({ redisAvailable: sentinel.sentinelRedis.available }));
app.get('/', (req, res) => res.redirect('/sentinel/dashboard'));

const server = http.createServer(app);
attachStream(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`Sentinel demo server listening on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/sentinel/dashboard`);
  console.log(`Metrics:   http://localhost:${PORT}/sentinel/metrics`);
  console.log(`Health:    http://localhost:${PORT}/health  (tells you if Redis actually connected)`);
  console.log(`REDIS_URL from .env: ${process.env.REDIS_URL ? '(found, length ' + process.env.REDIS_URL.length + ')' : 'NOT SET -- .env was not picked up'}`);
  // Give the connection a moment, then report the outcome plainly.
  setTimeout(() => {
    if (sentinel.sentinelRedis.available) {
      console.log('[sentinel] Redis: CONNECTED');
    } else {
      console.log('[sentinel] Redis: NOT connected. Last error:', sentinel.sentinelRedis.lastError && sentinel.sentinelRedis.lastError.message);
    }
  }, 1500);
});
