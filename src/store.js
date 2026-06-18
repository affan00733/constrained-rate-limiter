/**
 * In-memory bucket store. No Redis, no DB — just a Map, as the challenge requires.
 * Algorithm-agnostic: it holds opaque state objects created by whichever
 * algorithm is active (it only relies on `state.lastSeenMs` for sweeping).
 *
 * Two memory-safety mechanisms (a naive Map would leak forever):
 *  1. Idle sweep: a background timer drops buckets untouched for `maxIdleMs`.
 *  2. Hard cap: never hold more than `maxKeys`; on overflow evict the
 *     least-recently-used key (Map keeps insertion order; we re-insert on access).
 */

export class InMemoryStore {
  constructor(opts = {}) {
    this.map = new Map();
    this.apply(opts);
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  apply(opts = {}) {
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 30000;
    this.maxIdleMs = opts.maxIdleMs ?? 120000;
    this.maxKeys = opts.maxKeys ?? 100000;
  }

  configure(opts = {}) {
    const prev = this.sweepIntervalMs;
    this.apply(opts);
    if (this.sweepIntervalMs !== prev) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Get the bucket for `key`, creating it via `create(now)` if absent. */
  getOrCreate(key, now, create) {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key); // LRU bump
      this.map.set(key, existing);
      return existing;
    }
    if (this.map.size >= this.maxKeys) this.evictOldest();
    const fresh = create(now);
    this.map.set(key, fresh);
    return fresh;
  }

  evictOldest() {
    const oldest = this.map.keys().next().value;
    if (oldest !== undefined) this.map.delete(oldest);
  }

  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [key, state] of this.map) {
      if (now - state.lastSeenMs > this.maxIdleMs) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Delete buckets whose key starts with `prefix`; clears all if prefix is falsy. */
  deleteByPrefix(prefix) {
    let removed = 0;
    for (const key of this.map.keys()) {
      if (!prefix || key.startsWith(prefix)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear() {
    const n = this.map.size;
    this.map.clear();
    return n;
  }

  list() {
    return [...this.map.entries()];
  }

  get size() {
    return this.map.size;
  }

  stop() {
    clearInterval(this.timer);
  }
}
