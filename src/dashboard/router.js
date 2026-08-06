'use strict';

const express = require('express');
const path = require('path');

/**
 * Mountable router providing:
 *   GET /metrics    - Prometheus exposition format
 *   GET /dashboard  - the live dashboard UI (static build)
 *
 * WS streaming is attached separately (needs the raw http.Server) via
 * attachStream() below, since Express routers can't own a WS upgrade.
 */
function sentinelDashboardRouter(middleware) {
  const router = express.Router();
  const metrics = middleware.metrics;

  router.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  });

  router.use('/dashboard', express.static(path.join(__dirname, 'public')));

  return router;
}

/**
 * Attach the /sentinel/stream WebSocket endpoint to a raw http.Server.
 * Broadcasts every eventBus 'event' to all connected dashboard clients.
 */
function attachStream(httpServer, wsPath = '/sentinel/stream') {
  const { WebSocketServer } = require('ws');
  const eventBus = require('../eventBus');

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(wsPath)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
      });
    }
  });

  const onEvent = (evt) => {
    const payload = JSON.stringify(evt);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };
  eventBus.on('event', onEvent);

  return { wss, stop: () => eventBus.off('event', onEvent) };
}

module.exports = { sentinelDashboardRouter, attachStream };
