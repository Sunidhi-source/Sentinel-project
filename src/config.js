"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULTS = {
  redis: process.env.REDIS_URL
    ? process.env.REDIS_URL
    : {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT) || 6379,
      },
  redisFailureMode: "fail-open",
  defaultScope: "ip",
  defaultAlgorithm: "token-bucket",
  routes: {},
  ttlSeconds: 120,
};

function loadConfigFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  if (abs.endsWith(".yaml") || abs.endsWith(".yml")) {
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
  if (typeof input === "string") {
    userConfig = loadConfigFile(input);
  } else if (input && typeof input === "object") {
    userConfig = input;
  }

  // redis can be a connection string (URL) or a {host, port, ...} object.
  // Only merge as objects when both sides are objects; a URL string wins
  // outright since there's nothing sensible to merge it with.
  let resolvedRedis;
  if (typeof userConfig.redis === "string") {
    resolvedRedis = userConfig.redis;
  } else if (typeof DEFAULTS.redis === "string" && !userConfig.redis) {
    resolvedRedis = DEFAULTS.redis;
  } else {
    resolvedRedis = {
      ...(typeof DEFAULTS.redis === "object" ? DEFAULTS.redis : {}),
      ...(userConfig.redis || {}),
    };
  }

  const config = {
    ...DEFAULTS,
    ...userConfig,
    redis: resolvedRedis,
  };

  // Pre-parse route keys into matchers. Supports exact paths and simple
  // trailing-wildcard prefixes, e.g. "/api/upload/*".
  config._routeMatchers = Object.entries(config.routes || {}).map(
    ([pattern, ruleRaw]) => {
      const rule = {
        algorithm: DEFAULTS.defaultAlgorithm,
        scope: config.defaultScope,
        windowSeconds: 60,
        limit: 100,
        ...ruleRaw,
      };
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        return { test: (p) => p.startsWith(prefix), pattern, rule };
      }
      return { test: (p) => p === pattern, pattern, rule };
    },
  );

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
