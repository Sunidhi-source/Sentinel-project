'use strict';

const crypto = require('crypto');

function keyFor(routePattern, scopeKey, algorithm, suffix) {
  return `sentinel:{${routePattern}}:{${scopeKey}}:${algorithm}${suffix ? ':' + suffix : ''}`;
}

/**
 * Execute the configured algorithm's Lua script and normalize the result
 * into a common shape regardless of which algorithm ran.
 *
 * @returns {Promise<{allowed: boolean, remaining: number|null, retryAfterMs: number, limit: number}>}
 */
async function checkLimit(sentinelRedis, { routePattern, scopeKey, rule, nowMs }) {
  const { algorithm, limit, windowSeconds, ttlSeconds = 120 } = rule;
  const windowMs = windowSeconds * 1000;

  if (algorithm === 'token-bucket') {
    const key = keyFor(routePattern, scopeKey, 'tb');
    const refillRate = limit / windowSeconds; // tokens/sec so bucket refills fully over one window
    const [allowed, remaining, retryAfterMs] = await sentinelRedis.runScript(
      'token-bucket',
      [key],
      [limit, refillRate, nowMs, 1, ttlSeconds]
    );
    return { allowed: allowed === 1, remaining, retryAfterMs, limit };
  }

  if (algorithm === 'sliding-window-log') {
    const key = keyFor(routePattern, scopeKey, 'swl');
    const member = `${nowMs}-${crypto.randomBytes(6).toString('hex')}`;
    const [allowed, count, retryAfterMs] = await sentinelRedis.runScript(
      'sliding-window-log',
      [key],
      [nowMs, windowMs, limit, member, ttlSeconds]
    );
    return { allowed: allowed === 1, remaining: Math.max(0, limit - count), retryAfterMs, limit };
  }

  if (algorithm === 'sliding-window-counter') {
    const windowIndex = Math.floor(nowMs / windowMs);
    const currKey = keyFor(routePattern, scopeKey, 'swc', String(windowIndex));
    const prevKey = keyFor(routePattern, scopeKey, 'swc', String(windowIndex - 1));
    const [allowed, estimatedX1000, retryAfterMs] = await sentinelRedis.runScript(
      'sliding-window-counter',
      [currKey, prevKey],
      [nowMs, windowMs, limit, ttlSeconds]
    );
    const estimated = estimatedX1000 / 1000;
    return { allowed: allowed === 1, remaining: Math.max(0, Math.floor(limit - estimated)), retryAfterMs, limit };
  }

  throw new Error(`Unknown rate-limit algorithm: ${algorithm}`);
}

module.exports = { checkLimit, keyFor };
