'use strict';

const { EventEmitter } = require('events');

// Single shared bus per process. Multiple sentinelMiddleware() instances in
// the same process (e.g. limiting different route groups) all publish here;
// the dashboard server subscribes once.
class SentinelEventBus extends EventEmitter {
  publish(event) {
    this.emit('event', { ts: Date.now(), ...event });
  }
}

module.exports = new SentinelEventBus();
