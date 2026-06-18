/**
 * Token-bucket algorithm.
 *
 * Each algorithm in this folder implements the same interface so they are
 * interchangeable via config (`algorithm: "token-bucket" | "sliding-window"`):
 *
 *   create(now)            -> fresh state object (must include lastSeenMs)
 *   consume(state, rule, now, cost=1) -> { allowed, remaining, retryAfterMs, resetMs, limit }
 *   peek(state, rule, now) -> { remaining, limit }   (read-only, for the dashboard)
 *
 * `rule` is { capacity, refillPerMs, limit, windowMs }.
 *
 * Why token bucket: caps *sustained* throughput (the real incident) while
 * tolerating a small legitimate burst, O(1) memory per key, and an exact
 * Retry-After (time to refill the deficit).
 */

export const tokenBucket = {
  name: 'token-bucket',

  create(now) {
    return { tokens: null, lastRefillMs: now, lastSeenMs: now };
  },

  consume(state, rule, now, cost = 1) {
    if (state.tokens === null) state.tokens = rule.capacity; // start full

    const elapsed = Math.max(0, now - state.lastRefillMs);
    state.tokens = Math.min(rule.capacity, state.tokens + elapsed * rule.refillPerMs);
    state.lastRefillMs = now;
    state.lastSeenMs = now;

    let allowed = false;
    if (state.tokens >= cost) {
      state.tokens -= cost;
      allowed = true;
    }

    const remaining = Math.max(0, Math.floor(state.tokens));
    const deficit = allowed ? 0 : cost - state.tokens;
    const retryAfterMs = deficit > 0 ? Math.ceil(deficit / rule.refillPerMs) : 0;
    const resetMs = Math.ceil((rule.capacity - state.tokens) / rule.refillPerMs);

    return { allowed, remaining, retryAfterMs, resetMs, limit: rule.limit };
  },

  peek(state, rule, now) {
    const tokens =
      state.tokens === null
        ? rule.capacity
        : Math.min(rule.capacity, state.tokens + Math.max(0, now - state.lastRefillMs) * rule.refillPerMs);
    return { remaining: Math.max(0, Math.floor(tokens)), limit: rule.limit };
  },
};
