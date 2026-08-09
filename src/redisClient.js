'use strict';

const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const SCRIPT_FILES = {
  'token-bucket': 'token-bucket.lua',
  'sliding-window-log': 'sliding-window-log.lua',
  'sliding-window-counter': 'sliding-window-counter.lua',
};

class SentinelRedis {
  /**
   * @param {object} opts
   * @param {string|object} opts.redis - ioredis connection string or options object
   * @param {number} opts.connectTimeoutMs
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.shas = {};
    this.scriptSource = {};
    this.available = false;
    this.lastError = null;
    this._connecting = null;

    const redisOpts =
      typeof opts.redis === 'string'
        ? opts.redis
        : {
            host: (opts.redis && opts.redis.host) || '127.0.0.1',
            port: (opts.redis && opts.redis.port) || 6379,
            maxRetriesPerRequest: 1,
            retryStrategy: (times) => Math.min(times * 200, 2000),
            lazyConnect: true,
            ...opts.redis,
          };

    this.client = typeof redisOpts === 'string' ? new Redis(redisOpts, { lazyConnect: true, maxRetriesPerRequest: 1 }) : new Redis(redisOpts);

    this.client.on('error', (err) => {
      this.available = false;
      this.lastError = err;
      // eslint-disable-next-line no-console
      console.error('[sentinel] Redis connection error:', err && err.message ? err.message : err);
    });
    this.client.on('ready', () => {
      this.available = true;
    });
  }

  async connect() {
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      try {
        if (this.client.status === 'wait' || this.client.status === 'end') {
          await this.client.connect();
        }
        await this._loadScripts();
        this.available = true;
      } catch (err) {
        this.available = false;
        this.lastError = err;
      }
    })();
    return this._connecting;
  }

  async _loadScripts() {
    const dir = path.join(__dirname, 'algorithms');
    for (const [name, file] of Object.entries(SCRIPT_FILES)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      this.scriptSource[name] = src;
      const sha = await this.client.script('LOAD', src);
      this.shas[name] = sha;
    }
  }

  /**
   * Run a named algorithm script via EVALSHA, transparently reloading and
   * retrying once on NOSCRIPT (e.g. after a Redis restart / FLUSHALL wiped
   * the script cache).
   */
  async runScript(name, keys, args) {
    const sha = this.shas[name];
    try {
      return await this.client.evalsha(sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (err && /NOSCRIPT/.test(err.message)) {
        const newSha = await this.client.script('LOAD', this.scriptSource[name]);
        this.shas[name] = newSha;
        return await this.client.evalsha(newSha, keys.length, ...keys, ...args);
      }
      throw err;
    }
  }

  async ping() {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async quit() {
    try {
      await this.client.quit();
    } catch {
      /* noop */
    }
  }
}

module.exports = { SentinelRedis };
