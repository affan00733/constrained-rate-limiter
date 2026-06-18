/**
 * Config loader + resolver + hot-reload watcher.
 *
 * The whole policy (algorithm, tiers, limits, per-endpoint rules, client->tier
 * mapping, admin token) lives in a JSON file. Operators tune it by editing the
 * file OR via the admin API; either way the running process applies it live.
 * That is what satisfies "adjustable configuration without code changes".
 */

import { readFileSync, writeFileSync, watch } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { DEFAULT_ALGORITHM } from './algorithms/index.js';

/** Compile raw JSON into a fast resolver with sensible defaults applied once. */
export function buildConfig(raw) {
  const tiers = raw.tiers || {};
  const clients = raw.clients || {};
  const defaultTier = raw.defaultTier || 'standard';
  const algorithm = raw.algorithm || DEFAULT_ALGORITHM;

  const readMethods = new Set(
    (raw.methodClasses?.read || ['GET', 'HEAD', 'OPTIONS']).map((m) => m.toUpperCase())
  );
  const multipliers = { read: 1, write: 0.2, ...(raw.methodMultipliers || {}) };
  const overrides = (raw.endpointOverrides || []).map((o) => ({
    ...o,
    method: String(o.method).toUpperCase(),
  }));
  const skipPaths = new Set(raw.skipPaths || []);
  const skipPrefixes = raw.skipPrefixes || [];

  const ident = {
    header: 'x-api-key',
    ipFallback: true,
    trustProxy: false,
    ...(raw.identification || {}),
  };
  const store = {
    sweepIntervalMs: 30000,
    maxIdleMs: 120000,
    maxKeys: 100000,
    ...(raw.store || {}),
  };
  const admin = { token: null, ...(raw.admin || {}) };

  // Tier is looked up by the *raw* credential (API key or IP), not the
  // namespaced bucket id, so config stays human-friendly: { "my-key": "premium" }.
  const tierNameFor = (rawId) =>
    clients[rawId] && tiers[clients[rawId]] ? clients[rawId] : defaultTier;

  const ruleFrom = (limit, windowMs, burst) => ({
    capacity: Math.max(1, burst ?? limit), // burst defaults to the steady limit
    refillPerMs: limit / windowMs,
    limit,
    windowMs,
  });

  function isSkipped(path) {
    return skipPaths.has(path) || skipPrefixes.some((p) => path.startsWith(p));
  }

  /**
   * Decide which bucket + rule apply to a request.
   * @param {{kind:string, id:string}} principal  e.g. { kind:'key', id:'demo-premium-key' }
   * Returns { skip:true } for exempt paths, otherwise { key, scope, tier, rule }.
   */
  function resolve(principal, method, path) {
    method = String(method).toUpperCase();
    if (isSkipped(path)) return { skip: true };

    // `kind` namespaces the bucket so an API key and an IP can never collide.
    const clientId = `${principal.kind}:${principal.id}`;
    const tierName = tierNameFor(principal.id);
    const tier = tiers[tierName] || { limit: 100, windowMs: 60000 };

    // 1) Explicit per-endpoint override wins (e.g. an expensive write path).
    for (const o of overrides) {
      if (o.method === method && o.path === path) {
        return {
          key: `${clientId}|ovr:${o.method}:${o.path}`,
          scope: `override ${o.method} ${o.path}`,
          tier: tierName,
          clientId,
          rule: ruleFrom(o.limit, o.windowMs ?? tier.windowMs, o.burst),
        };
      }
    }

    // 2) Otherwise differentiate reads from writes within the client's tier.
    const cls = readMethods.has(method) ? 'read' : 'write';
    const limit = Math.max(1, Math.round(tier.limit * (multipliers[cls] ?? 1)));
    return {
      key: `${clientId}|${cls}`,
      scope: `${cls} (${tierName} tier)`,
      tier: tierName,
      clientId,
      rule: ruleFrom(limit, tier.windowMs, tier.burst),
    };
  }

  return { resolve, isSkipped, ident, store, admin, tiers, defaultTier, algorithm, raw };
}

export function loadConfig(path) {
  const abs = resolvePath(path);
  return buildConfig(JSON.parse(readFileSync(abs, 'utf8')));
}

export function saveConfig(path, raw) {
  writeFileSync(resolvePath(path), JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/**
 * Watch the config file and invoke onChange(newConfig) on edits.
 * Debounced (editors fire several events per save) and crash-proof: a malformed
 * edit is logged and the previous good config is kept.
 */
export function watchConfig(path, onChange) {
  const abs = resolvePath(path);
  let debounce = null;
  const watcher = watch(abs, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        onChange(loadConfig(abs));
        console.log('[ratelimit] config reloaded');
      } catch (err) {
        console.error('[ratelimit] bad config, keeping previous:', err.message);
      }
    }, 150);
  });
  watcher.unref?.();
  return () => watcher.close();
}
