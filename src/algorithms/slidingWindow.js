/**
 * Sliding-window-counter algorithm (same interface as tokenBucket).
 *
 * Keeps two fixed buckets — the current window and the previous one — and
 * weights the previous count by how much of it still overlaps the trailing
 * `windowMs`. This approximates a true sliding log at O(1) memory (two ints +
 * a timestamp) instead of one timestamp per request.
 *
 * Trade-off vs token bucket: no burst allowance beyond `limit`, and a smoother
 * "no more than N in any rolling window" guarantee — at the cost of a slightly
 * approximate Retry-After near window boundaries (documented inline).
 */

export const slidingWindow = {
  name: 'sliding-window',

  create(now) {
    return { windowStartMs: now, currCount: 0, prevCount: 0, lastSeenMs: now };
  },

  /** Roll the window forward to "contain" `now`. */
  _advance(state, windowMs, now) {
    const elapsedWindows = Math.floor((now - state.windowStartMs) / windowMs);
    if (elapsedWindows <= 0) return;
    if (elapsedWindows === 1) {
      state.prevCount = state.currCount;
      state.currCount = 0;
    } else {
      // Two or more full windows elapsed: history is irrelevant.
      state.prevCount = 0;
      state.currCount = 0;
    }
    state.windowStartMs += elapsedWindows * windowMs;
  },

  consume(state, rule, now, cost = 1) {
    const W = rule.windowMs;
    const limit = rule.limit;
    this._advance(state, W, now);

    const elapsedInCurr = now - state.windowStartMs; // 0..W
    const prevWeight = Math.max(0, (W - elapsedInCurr) / W);
    const weighted = state.prevCount * prevWeight + state.currCount;

    let allowed = false;
    if (weighted + cost <= limit) {
      state.currCount += cost;
      allowed = true;
    }
    state.lastSeenMs = now;

    const used = weighted + (allowed ? cost : 0);
    const remaining = Math.max(0, Math.floor(limit - used));

    // Retry-After: time for the weighted estimate to drop enough for one more.
    // The decaying part is the previous window (prevCount/W per ms); if it's
    // empty we must wait for the current window to roll over.
    let retryAfterMs = 0;
    if (!allowed) {
      const excess = weighted + cost - limit;
      retryAfterMs =
        state.prevCount > 0
          ? Math.min(Math.ceil((excess * W) / state.prevCount), W - elapsedInCurr)
          : W - elapsedInCurr;
      retryAfterMs = Math.max(1, retryAfterMs);
    }

    const resetMs = W - elapsedInCurr; // when the current window rolls
    return { allowed, remaining, retryAfterMs, resetMs, limit };
  },

  peek(state, rule, now) {
    const W = rule.windowMs;
    const elapsedInCurr = Math.min(W, Math.max(0, now - state.windowStartMs));
    const prevWeight = Math.max(0, (W - elapsedInCurr) / W);
    const weighted = state.prevCount * prevWeight + state.currCount;
    return { remaining: Math.max(0, Math.floor(rule.limit - weighted)), limit: rule.limit };
  },
};
