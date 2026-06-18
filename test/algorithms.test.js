/**
 * Unit tests for the rate-limiting algorithms (Node's built-in test runner).
 * Run: `npm test`. Time is injected (`now`) so tests are deterministic — no sleeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenBucket } from '../src/algorithms/tokenBucket.js';
import { slidingWindow } from '../src/algorithms/slidingWindow.js';

const rule = (limit, windowMs = 60000, burst) => ({
  capacity: burst ?? limit,
  refillPerMs: limit / windowMs,
  limit,
  windowMs,
});

test('token bucket: allows up to capacity then blocks', () => {
  const r = rule(5);
  const s = tokenBucket.create(0);
  let allowed = 0;
  for (let i = 0; i < 8; i++) if (tokenBucket.consume(s, r, 0).allowed) allowed++;
  assert.equal(allowed, 5, 'exactly capacity requests pass at t=0');
});

test('token bucket: refills over time', () => {
  const r = rule(60, 60000); // 1 token per 1000ms
  const s = tokenBucket.create(0);
  for (let i = 0; i < 60; i++) tokenBucket.consume(s, r, 0); // drain
  assert.equal(tokenBucket.consume(s, r, 0).allowed, false, 'empty right after draining');
  assert.equal(tokenBucket.consume(s, r, 1000).allowed, true, 'one token back after 1s');
});

test('token bucket: reports a positive Retry-After when blocked', () => {
  const r = rule(1, 60000);
  const s = tokenBucket.create(0);
  assert.equal(tokenBucket.consume(s, r, 0).allowed, true);
  const denied = tokenBucket.consume(s, r, 0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0, 'retryAfterMs should be > 0');
});

test('token bucket: remaining never goes negative', () => {
  const r = rule(3);
  const s = tokenBucket.create(0);
  for (let i = 0; i < 10; i++) {
    const res = tokenBucket.consume(s, r, 0);
    assert.ok(res.remaining >= 0);
  }
});

test('sliding window: allows up to limit within a window then blocks', () => {
  const r = rule(10, 1000);
  const s = slidingWindow.create(0);
  let allowed = 0;
  for (let i = 0; i < 15; i++) if (slidingWindow.consume(s, r, 0).allowed) allowed++;
  assert.equal(allowed, 10, 'exactly limit requests pass within one window');
});

test('sliding window: frees up after the window fully passes', () => {
  const r = rule(10, 1000);
  const s = slidingWindow.create(0);
  for (let i = 0; i < 10; i++) slidingWindow.consume(s, r, 0); // fill window
  assert.equal(slidingWindow.consume(s, r, 0).allowed, false, 'blocked at end of window');
  // Two full windows later, history is gone -> allowed again.
  assert.equal(slidingWindow.consume(s, r, 2000).allowed, true);
});

test('sliding window: smooths the boundary (no full 2x burst)', () => {
  const r = rule(10, 1000);
  const s = slidingWindow.create(0);
  for (let i = 0; i < 10; i++) slidingWindow.consume(s, r, 0); // 10 in window 1
  // Immediately into window 2 (t=1000): previous window still ~fully weighted,
  // so we should NOT be able to push another full 10 through.
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (slidingWindow.consume(s, r, 1000).allowed) allowed++;
  assert.ok(allowed < 10, `expected throttling at boundary, got ${allowed} allowed`);
});

test('both algorithms expose the same interface', () => {
  for (const algo of [tokenBucket, slidingWindow]) {
    assert.equal(typeof algo.name, 'string');
    assert.equal(typeof algo.create, 'function');
    assert.equal(typeof algo.consume, 'function');
    assert.equal(typeof algo.peek, 'function');
    const r = rule(5);
    const s = algo.create(0);
    const res = algo.consume(s, r, 0);
    for (const k of ['allowed', 'remaining', 'retryAfterMs', 'resetMs', 'limit']) {
      assert.ok(k in res, `${algo.name}.consume result missing ${k}`);
    }
    const pk = algo.peek(s, r, 0);
    assert.ok('remaining' in pk && 'limit' in pk);
  }
});
