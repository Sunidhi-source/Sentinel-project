#!/usr/bin/env node
'use strict';

// Standalone Sentinel Gateway.
//
// For services NOT written in Node (Python, Go, Java, whatever): run this
// as a sidecar/reverse-proxy in front of them instead of installing the
// npm middleware. Rate-limit decisions still happen via the same atomic
// Redis Lua scripts as the embedded middleware, so behavior is identical.
//
// Config (env or file):
//   SENTINEL_CONFIG   path to JSON/YAML config (routes, algorithms, limits)
//   UPSTREAMS         comma-separated list of upstream origin URLs, round-robined
//   PORT              gateway listen port (default 8080)
//   REDIS_HOST / REDIS_PORT

const express = require('express');
const http = require('http');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { sentinelMiddleware } = require('../src/index');
const { sentinelDashboardRouter, attachStream } = require('../src/dashboard/router');

const PORT = Number(process.env.PORT) || 8080;
const CONFIG_PATH = process.env.SENTINEL_CONFIG || path.join(__dirname, '..', 'examples', 'sentinel.config.json');
const UPSTREAMS = (process.env.UPSTREAMS || 'http://localhost:5001,http://localhost:5002,http://localhost:5003')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let rrIndex = 0;
function nextUpstream() {
  const target = UPSTREAMS[rrIndex % UPSTREAMS.length];
  rrIndex++;
  return target;
}

const app = express();

const sentinel = sentinelMiddleware(CONFIG_PATH, {
  redisClient: undefined, // let it build its own from config.redis / env below
});

app.use('/sentinel', sentinelDashboardRouter(sentinel));

// Rate limit check happens BEFORE the proxy hop -- rejected requests never
// touch an upstream instance at all.
app.use(sentinel);

app.use(
  '/',
  createProxyMiddleware({
    router: () => nextUpstream(),
    changeOrigin: true,
    logLevel: 'warn',
  })
);

const server = http.createServer(app);
attachStream(server);

server.listen(PORT, () => {
  console.log(`Sentinel Gateway listening on :${PORT}`);
  console.log(`Proxying to upstreams (round-robin): ${UPSTREAMS.join(', ')}`);
  console.log(`Dashboard: http://localhost:${PORT}/sentinel/dashboard`);
});
