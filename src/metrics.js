'use strict';

const client = require('prom-client');

function createMetrics(registerDefaults = false) {
  const register = new client.Registry();
  if (registerDefaults) client.collectDefaultMetrics({ register });

  const requestsTotal = new client.Counter({
    name: 'sentinel_requests_total',
    help: 'Total requests seen by Sentinel',
    labelNames: ['route', 'scope', 'algorithm'],
    registers: [register],
  });

  const throttledTotal = new client.Counter({
    name: 'sentinel_throttled_total',
    help: 'Total requests rejected with 429',
    labelNames: ['route', 'scope', 'algorithm'],
    registers: [register],
  });

  const decisionLatency = new client.Histogram({
    name: 'sentinel_decision_latency_ms',
    help: 'Latency added by the Redis rate-limit check, in milliseconds',
    buckets: [0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 25, 50],
    registers: [register],
  });

  const redisUp = new client.Gauge({
    name: 'sentinel_redis_up',
    help: '1 if Redis is reachable, 0 if Sentinel is running in degraded mode',
    registers: [register],
  });

  return { register, requestsTotal, throttledTotal, decisionLatency, redisUp };
}

module.exports = { createMetrics };
