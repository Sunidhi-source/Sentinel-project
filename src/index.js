'use strict';

const { SentinelRedis } = require('./redisClient');
const { resolveConfig, matchRoute } = require('./config');
const { checkLimit } = require('./limiter');
const { createMetrics } = require('./metrics');
const eventBus = require('./eventBus');

/**
 * Resolve the identity Sentinel uses to scope a rate limit for this request.
 */
function resolveScopeKey(req, scope) {
  if (scope === 'apiKey') {
    const key = req.headers['x-api-key'] || (req.query && req.query.apiKey);
    if (key) return `apiKey:${key}`;
  }
  if (scope === 'userId') {
    const id = (req.user && req.user.id) || req.headers['x-user-id'];
    if (id) return `userId:${id}`;
  }
  // 'ip' scope, and the fallback when apiKey/userId scope was requested but
  // the request didn't actually carry one (e.g. anonymous traffic).
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    'unknown';
  return `ip:${ip}`;
}

/**
 * sentinelMiddleware(config) -> Express middleware
 *
 * config can be:
 *  - a path to a JSON/YAML config file
 *  - a plain config object (see README for shape)
 *
 * 3-line integration:
 *   const { sentinelMiddleware } = require('sentinel-limiter');
 *   app.use(sentinelMiddleware('./sentinel.config.json'));
 */
function sentinelMiddleware(configInput, opts = {}) {
  const config = resolveConfig(configInput);
  const sentinelRedis = opts.redisClient || new SentinelRedis({ redis: config.redis });
  const metrics = opts.metrics || createMetrics();
  let connectPromise = sentinelRedis.connect();

  const middleware = async function sentinel(req, res, next) {
    const rule = matchRoute(config, req.path);
    const scopeKey = resolveScopeKey(req, rule.scope);
    const nowMs = Date.now();
    const start = process.hrtime.bigint();

    metrics.requestsTotal.inc({ route: req.path, scope: rule.scope, algorithm: rule.algorithm });

    // Make sure we've at least attempted a connection once. This resolves
    // instantly after the first successful/failed connect.
    if (!sentinelRedis.available) {
      try {
        await Promise.race([connectPromise, new Promise((r) => setTimeout(r, 50))]);
      } catch {
        /* handled below via .available flag */
      }
    }

    if (!sentinelRedis.available) {
      metrics.redisUp.set(0);
      return handleRedisDown(req, res, next, config, rule, metrics);
    }
    metrics.redisUp.set(1);

    try {
      const result = await checkLimit(sentinelRedis, {
        routePattern: req.path,
        scopeKey,
        rule,
        nowMs,
      });

      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.decisionLatency.observe(elapsedMs);

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining ?? 0)));
      res.setHeader('X-Sentinel-Algorithm', rule.algorithm);

      if (!result.allowed) {
        metrics.throttledTotal.inc({ route: req.path, scope: rule.scope, algorithm: rule.algorithm });
        const retryAfterSec = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));

        eventBus.publish({
          type: 'throttled',
          route: req.path,
          scope: rule.scope,
          scopeKey,
          algorithm: rule.algorithm,
          limit: result.limit,
        });

        return res.status(429).json({
          error: 'Too Many Requests',
          retryAfterSeconds: retryAfterSec,
          limit: result.limit,
        });
      }

      eventBus.publish({
        type: 'allowed',
        route: req.path,
        scope: rule.scope,
        scopeKey,
        algorithm: rule.algorithm,
        remaining: result.remaining,
      });

      return next();
    } catch (err) {
      sentinelRedis.available = false;
      sentinelRedis.lastError = err;
      metrics.redisUp.set(0);
      return handleRedisDown(req, res, next, config, rule, metrics, err);
    }
  };

  middleware.sentinelRedis = sentinelRedis;
  middleware.metrics = metrics;
  middleware.config = config;
  return middleware;
}

function handleRedisDown(req, res, next, config, rule, metrics, err) {
  eventBus.publish({
    type: 'redis-down',
    route: req.path,
    mode: config.redisFailureMode,
    error: err ? err.message : 'not connected',
  });

  if (config.redisFailureMode === 'fail-closed') {
    // Explicit choice: protect the origin at the cost of availability when
    // Redis is unreachable. Better than silently letting everything through
    // during an outage if the operator decided limits are safety-critical.
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: 'Service temporarily unavailable (rate limiter degraded, fail-closed mode)',
    });
  }
  // fail-open (default): don't let a Redis outage take down the whole API.
  res.setHeader('X-Sentinel-Degraded', 'true');
  return next();
}

module.exports = { sentinelMiddleware, SentinelRedis, resolveConfig };
