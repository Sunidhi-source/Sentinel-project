'use strict';

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
  redis: { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT) || 6379 },
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
app.get('/', (req, res) => res.redirect('/sentinel/dashboard'));

const server = http.createServer(app);
attachStream(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Sentinel demo server listening on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/sentinel/dashboard`);
  console.log(`Metrics:   http://localhost:${PORT}/sentinel/metrics`);
});
