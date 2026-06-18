/**
 * Express adapter — the ONLY integration point: `app.use(limiter)`.
 * Routes contain zero rate-limit logic (the requirement is middleware-only).
 *
 * The core (store + algorithms + config + metrics) is framework-agnostic;
 * this file maps Express req/res onto it and exposes ops handles
 * (metrics, live snapshot, runtime config updates) for the dashboard/admin API.
 */

import { InMemoryStore } from './store.js';
import { Metrics } from './metrics.js';
import { loadConfig, buildConfig, saveConfig, watchConfig } from './config.js';
import { getAlgorithm } from './algorithms/index.js';

export function createRateLimiter(opts = {}) {
  const configPath =
    opts.configPath || process.env.RATELIMIT_CONFIG || './config/ratelimit.config.json';

  let cfg = loadConfig(configPath);
  const store = new InMemoryStore(cfg.store);
  const metrics = new Metrics(cfg.raw.metrics?.recentEvents ?? 200);

  // Swap in a new config; if the algorithm changed, existing bucket states have
  // a different shape, so we clear the store rather than mixing them.
  function applyConfig(next) {
    if (next.algorithm !== cfg.algorithm) store.clear();
    cfg = next;
    store.configure(next.store);
  }

  const unwatch = watchConfig(configPath, applyConfig);

  /** Identify the caller: API key if present, else IP, else anonymous. */
  function principalOf(req) {
    const headerName = cfg.ident.header?.toLowerCase();
    const key = headerName && req.headers[headerName];
    if (key) return { kind: 'key', id: String(key) };
    if (cfg.ident.ipFallback) {
      return { kind: 'ip', id: req.ip || req.socket?.remoteAddress || 'unknown' };
    }
    return { kind: 'anon', id: 'anonymous' };
  }

  const middleware = (req, res, next) => {
    const principal = principalOf(req);
    const decision = cfg.resolve(principal, req.method, req.path);
    if (decision.skip) return next();

    const algo = getAlgorithm(cfg.algorithm);
    const now = Date.now();
    const state = store.getOrCreate(decision.key, now, (n) => algo.create(n));
    const result = algo.consume(state, decision.rule, now);

    // Cache display metadata on the bucket so the dashboard can render it.
    state.meta = {
      clientId: decision.clientId,
      tier: decision.tier,
      scope: decision.scope,
      method: req.method,
      path: req.path,
      rule: decision.rule,
      algorithm: algo.name,
    };

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + result.resetMs) / 1000));
    res.setHeader('X-RateLimit-Scope', decision.scope);
    res.setHeader('X-RateLimit-Policy', algo.name);

    const status = result.allowed ? res.statusCode || 200 : 429;
    metrics.record({
      clientId: decision.clientId,
      tier: decision.tier,
      scope: decision.scope,
      method: req.method,
      path: req.path,
      status: result.allowed ? 200 : 429,
      remaining: result.remaining,
    });

    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.setHeader('Retry-After', retryAfter); // RFC 7231, in seconds
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message:
          `Rate limit exceeded for ${decision.scope}. ` +
          `Limit is ${result.limit} request(s) per ${Math.round(decision.rule.windowMs / 1000)}s.`,
        limit: result.limit,
        remaining: 0,
        retryAfterSeconds: retryAfter,
        scope: decision.scope,
        policy: algo.name,
      });
    }
    return next();
  };

  // ── Ops handles for the host app (dashboard, admin API, graceful shutdown) ──
  middleware.metrics = metrics;
  middleware.store = store;
  middleware.getConfig = () => cfg;

  /** Read-only view of every live bucket (for the dashboard). */
  middleware.snapshot = (now = Date.now()) => {
    const out = [];
    for (const [key, state] of store.list()) {
      const m = state.meta;
      if (!m) continue;
      const p = getAlgorithm(m.algorithm).peek(state, m.rule, now);
      out.push({
        key,
        clientId: m.clientId,
        tier: m.tier,
        scope: m.scope,
        remaining: p.remaining,
        limit: p.limit,
        idleMs: now - state.lastSeenMs,
      });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  };

  /** Apply a mutation to the raw config, persist it, and hot-swap live. */
  middleware.updateConfig = (mutator) => {
    const raw = structuredClone(cfg.raw);
    mutator(raw);
    applyConfig(buildConfig(raw));
    saveConfig(configPath, raw);
    return cfg;
  };

  /** Drop a client's buckets (or all, if no client given). Returns count removed. */
  middleware.resetClient = (clientId) => store.deleteByPrefix(clientId);

  middleware.stop = () => {
    unwatch();
    store.stop();
  };
  return middleware;
}
