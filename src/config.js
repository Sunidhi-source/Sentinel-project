'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULTS = {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
  redisFailureMode: 'fail-open', // 'fail-open' | 'fail-closed'
  defaultScope: 'ip', // 'ip' | 'apiKey' | 'userId'
  defaultAlgorithm: 'token-bucket',
  routes: {},
  ttlSeconds: 120,
};

function loadConfigFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  if (abs.endsWith('.yaml') || abs.endsWith('.yml')) {
    return yaml.load(raw);
  }
  return JSON.parse(raw);
}

/**
 * Normalize user-supplied config (object or file path) into a fully
 * resolved config with defaults filled in, and pre-compile route matchers.
 */
function resolveConfig(input) {
  let userConfig = {};
  if (typeof input === 'string') {
    userConfig = loadConfigFile(input);
  } else if (input && typeof input === 'object') {
    userConfig = input;
  }

  const config = {
    ...DEFAULTS,
    ...userConfig,
    redis: { ...DEFAULTS.redis, ...(userConfig.redis || {}) },
  };

  // Pre-parse route keys into matchers. Supports exact paths and simple
  // trailing-wildcard prefixes, e.g. "/api/upload/*".
  config._routeMatchers = Object.entries(config.routes || {}).map(([pattern, ruleRaw]) => {
    const rule = {
      algorithm: DEFAULTS.defaultAlgorithm,
      scope: config.defaultScope,
      windowSeconds: 60,
      limit: 100,
      ...ruleRaw,
    };
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return { test: (p) => p.startsWith(prefix), pattern, rule };
    }
    return { test: (p) => p === pattern, pattern, rule };
  });

  return config;
}

function matchRoute(config, requestPath) {
  for (const matcher of config._routeMatchers) {
    if (matcher.test(requestPath)) return matcher.rule;
  }
  // No explicit rule: fall back to a permissive default so unconfigured
  // routes aren't silently unprotected but also aren't overly strict.
  return {
    algorithm: config.defaultAlgorithm,
    scope: config.defaultScope,
    windowSeconds: 60,
    limit: 1000,
    _default: true,
  };
}

module.exports = { resolveConfig, matchRoute, DEFAULTS };
