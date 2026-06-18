/**
 * In-memory metrics collector (no external metrics backend — constraint-friendly).
 * Tracks running counters plus a bounded ring buffer of recent events, which
 * powers both the /metrics endpoint and the live dashboard.
 */

export class Metrics {
  constructor(maxEvents = 200) {
    this.maxEvents = maxEvents;
    this.reset();
  }

  reset() {
    this.startedAt = Date.now();
    this.total = 0;
    this.allowed = 0;
    this.blocked = 0;
    this.byTier = {}; // tier -> { allowed, blocked }
    this.byScope = {}; // scope -> { allowed, blocked }
    this.byClient = {}; // clientId -> { allowed, blocked }
    this.events = []; // recent { ts, clientId, tier, scope, method, path, status, remaining }
  }

  _bump(bucket, key, blocked) {
    const b = (bucket[key] ??= { allowed: 0, blocked: 0 });
    if (blocked) b.blocked++;
    else b.allowed++;
  }

  record(e) {
    const blocked = e.status === 429;
    this.total++;
    if (blocked) this.blocked++;
    else this.allowed++;
    this._bump(this.byTier, e.tier, blocked);
    this._bump(this.byScope, e.scope, blocked);
    this._bump(this.byClient, e.clientId, blocked);

    this.events.push({ ts: Date.now(), ...e });
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  /** Highest-volume clients — the "who's hammering us" view. */
  topClients(n = 5) {
    return Object.entries(this.byClient)
      .map(([clientId, c]) => ({ clientId, ...c, total: c.allowed + c.blocked }))
      .sort((a, b) => b.total - a.total)
      .slice(0, n);
  }

  summary() {
    return {
      uptimeMs: Date.now() - this.startedAt,
      total: this.total,
      allowed: this.allowed,
      blocked: this.blocked,
      blockRate: this.total ? +(this.blocked / this.total).toFixed(4) : 0,
      byTier: this.byTier,
      byScope: this.byScope,
      topClients: this.topClients(),
    };
  }

  /** Prometheus text exposition format. */
  prometheus() {
    const lines = [];
    const help = (name, type, doc) => {
      lines.push(`# HELP ${name} ${doc}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    help('ratelimit_requests_total', 'counter', 'Total requests seen by the limiter.');
    lines.push(`ratelimit_requests_total ${this.total}`);
    help('ratelimit_allowed_total', 'counter', 'Requests allowed.');
    lines.push(`ratelimit_allowed_total ${this.allowed}`);
    help('ratelimit_blocked_total', 'counter', 'Requests blocked with 429.');
    lines.push(`ratelimit_blocked_total ${this.blocked}`);
    help('ratelimit_blocked_by_tier_total', 'counter', 'Blocked requests by tier.');
    for (const [tier, c] of Object.entries(this.byTier)) {
      lines.push(`ratelimit_blocked_by_tier_total{tier="${tier}"} ${c.blocked}`);
    }
    return lines.join('\n') + '\n';
  }
}
