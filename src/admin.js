/**
 * Admin / ops API (Express Router), mounted at /admin.
 *
 * Lets operators inspect and retune the limiter at runtime — change tier limits,
 * switch algorithm, reset a client, read metrics — WITHOUT a restart or code
 * change. Guarded by an `x-admin-token` header when one is configured.
 *
 * Note: these are ordinary routes; the rate-limiting itself is still applied by
 * the single app-wide middleware. /admin is exempted via config skipPrefixes.
 */

import express from 'express';

export function createAdminRouter(limiter) {
  const router = express.Router();
  router.use(express.json());

  // Auth gate: only enforced when a token is set in config.
  router.use((req, res, next) => {
    const required = limiter.getConfig().admin?.token;
    if (required && req.headers['x-admin-token'] !== required) {
      return res.status(401).json({ error: 'unauthorized', hint: 'send x-admin-token header' });
    }
    next();
  });

  router.get('/config', (_req, res) => res.json(limiter.getConfig().raw));

  router.get('/stats', (_req, res) =>
    res.json({
      algorithm: limiter.getConfig().algorithm,
      metrics: limiter.metrics.summary(),
      buckets: limiter.snapshot(),
    })
  );

  router.patch('/tiers/:tier', (req, res) => {
    const { tier } = req.params;
    const { limit, windowMs } = req.body || {};
    if (limit == null && windowMs == null) {
      return res.status(400).json({ error: 'provide limit and/or windowMs' });
    }
    limiter.updateConfig((raw) => {
      raw.tiers ||= {};
      raw.tiers[tier] ||= { limit: 100, windowMs: 60000 };
      if (limit != null) raw.tiers[tier].limit = Number(limit);
      if (windowMs != null) raw.tiers[tier].windowMs = Number(windowMs);
    });
    res.json({ updated: true, tiers: limiter.getConfig().raw.tiers });
  });

  router.patch('/algorithm', (req, res) => {
    const { algorithm } = req.body || {};
    if (!['token-bucket', 'sliding-window'].includes(algorithm)) {
      return res.status(400).json({ error: 'algorithm must be token-bucket or sliding-window' });
    }
    limiter.updateConfig((raw) => {
      raw.algorithm = algorithm;
    });
    res.json({ updated: true, algorithm });
  });

  router.post('/reset', (req, res) => {
    const { client } = req.body || {};
    const removed = limiter.resetClient(client); // falsy client => clears all
    res.json({ reset: true, client: client || 'ALL', bucketsRemoved: removed });
  });

  router.post('/metrics/reset', (_req, res) => {
    limiter.metrics.reset();
    res.json({ reset: true });
  });

  return router;
}
