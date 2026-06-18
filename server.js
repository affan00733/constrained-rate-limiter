/**
 * Demo host app.
 *
 * The business routes below contain NO rate-limiting code: the single
 * `app.use(limiter)` line protects the entire API (the "middleware-only,
 * not per-route" requirement, made visible).
 *
 * Everything else (dashboard, Swagger docs, admin API, metrics, SSE stream) is
 * clearly-separated ops/demo tooling layered on top — it does not change how
 * limiting works, it just observes and controls it.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import swaggerUi from 'swagger-ui-express';

import { createRateLimiter } from './src/middleware.js';
import { createAdminRouter } from './src/admin.js';
import { openapiSpec } from './src/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', true); // so req.ip is the real client behind a proxy/LB
app.use(express.json());

const limiter = createRateLimiter({
  configPath: process.env.RATELIMIT_CONFIG || './config/ratelimit.config.json',
});

// ── The ONE integration point ────────────────────────────────────────────────
app.use(limiter);
// ─────────────────────────────────────────────────────────────────────────────

// Plain business routes — completely unaware of rate limiting.
app.get('/api/items', (_req, res) => res.json({ items: [{ id: 1 }, { id: 2 }] }));
app.post('/api/items', (req, res) => res.status(201).json({ created: true, body: req.body ?? null }));
app.post('/api/expensive', (_req, res) => res.json({ ran: true }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Ops & demo tooling (all exempt from limiting via config skipPrefixes) ─────

// Interactive API docs.
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'Rate Limiter API' }));

// Runtime admin/control API.
app.use('/admin', createAdminRouter(limiter));

// Prometheus metrics.
app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(limiter.metrics.prometheus());
});

// Quick JSON stats.
app.get('/__ratelimit/stats', (_req, res) =>
  res.json({ trackedKeys: limiter.store.size, tiers: limiter.getConfig().tiers })
);

// Live stream (Server-Sent Events) powering the dashboard.
app.get('/__ratelimit/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  const tick = () => {
    const payload = {
      algorithm: limiter.getConfig().algorithm,
      tiers: limiter.getConfig().tiers,
      metrics: limiter.metrics.summary(),
      buckets: limiter.snapshot(),
      events: limiter.metrics.events.slice(-30),
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  tick();
  const id = setInterval(tick, 500);
  req.on('close', () => clearInterval(id));
});

// Live dashboard (static HTML) + convenience redirect.
app.use('/dashboard', express.static(join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`rate-limited API listening on http://localhost:${PORT}`);
  console.log(`  dashboard : http://localhost:${PORT}/dashboard`);
  console.log(`  API docs  : http://localhost:${PORT}/docs`);
  console.log(`  metrics   : http://localhost:${PORT}/metrics`);
});

function shutdown() {
  limiter.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
