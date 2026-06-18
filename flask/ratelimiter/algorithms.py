"""Pluggable rate-limiting algorithms (pure Python, no framework).

Same interface as the Node implementation, proving the design is portable:
    create(now)               -> state dict (always has 'last_seen')
    consume(state, rule, now) -> dict(allowed, remaining, retry_after_ms, reset_ms, limit)
    peek(state, rule, now)    -> dict(remaining, limit)

`rule` = {capacity, refill_per_ms, limit, window_ms}. Time is in milliseconds.
"""

import math


class TokenBucket:
    """Burst-tolerant; caps sustained throughput. O(1) memory per key."""

    name = "token-bucket"

    @staticmethod
    def create(now):
        return {"tokens": None, "last_refill": now, "last_seen": now}

    @staticmethod
    def consume(s, rule, now, cost=1):
        if s["tokens"] is None:
            s["tokens"] = rule["capacity"]  # start full
        elapsed = max(0, now - s["last_refill"])
        s["tokens"] = min(rule["capacity"], s["tokens"] + elapsed * rule["refill_per_ms"])
        s["last_refill"] = now
        s["last_seen"] = now

        allowed = s["tokens"] >= cost
        if allowed:
            s["tokens"] -= cost

        remaining = max(0, math.floor(s["tokens"]))
        deficit = 0 if allowed else cost - s["tokens"]
        retry_after_ms = math.ceil(deficit / rule["refill_per_ms"]) if deficit > 0 else 0
        reset_ms = math.ceil((rule["capacity"] - s["tokens"]) / rule["refill_per_ms"])
        return {
            "allowed": allowed,
            "remaining": remaining,
            "retry_after_ms": retry_after_ms,
            "reset_ms": reset_ms,
            "limit": rule["limit"],
        }

    @staticmethod
    def peek(s, rule, now):
        if s["tokens"] is None:
            tokens = rule["capacity"]
        else:
            tokens = min(rule["capacity"], s["tokens"] + max(0, now - s["last_refill"]) * rule["refill_per_ms"])
        return {"remaining": max(0, math.floor(tokens)), "limit": rule["limit"]}


class SlidingWindow:
    """Smooth 'no more than N in any rolling window'; no burst beyond the limit."""

    name = "sliding-window"

    @staticmethod
    def create(now):
        return {"window_start": now, "curr": 0, "prev": 0, "last_seen": now}

    @staticmethod
    def _advance(s, w, now):
        elapsed_windows = math.floor((now - s["window_start"]) / w)
        if elapsed_windows <= 0:
            return
        if elapsed_windows == 1:
            s["prev"] = s["curr"]
            s["curr"] = 0
        else:
            s["prev"] = 0
            s["curr"] = 0
        s["window_start"] += elapsed_windows * w

    @classmethod
    def consume(cls, s, rule, now, cost=1):
        w = rule["window_ms"]
        limit = rule["limit"]
        cls._advance(s, w, now)

        elapsed_in_curr = now - s["window_start"]
        prev_weight = max(0, (w - elapsed_in_curr) / w)
        weighted = s["prev"] * prev_weight + s["curr"]

        allowed = weighted + cost <= limit
        if allowed:
            s["curr"] += cost
        s["last_seen"] = now

        used = weighted + (cost if allowed else 0)
        remaining = max(0, math.floor(limit - used))

        retry_after_ms = 0
        if not allowed:
            excess = weighted + cost - limit
            if s["prev"] > 0:
                retry_after_ms = min(math.ceil(excess * w / s["prev"]), w - elapsed_in_curr)
            else:
                retry_after_ms = w - elapsed_in_curr
            retry_after_ms = max(1, retry_after_ms)

        return {
            "allowed": allowed,
            "remaining": remaining,
            "retry_after_ms": retry_after_ms,
            "reset_ms": w - elapsed_in_curr,
            "limit": limit,
        }

    @staticmethod
    def peek(s, rule, now):
        w = rule["window_ms"]
        elapsed_in_curr = min(w, max(0, now - s["window_start"]))
        prev_weight = max(0, (w - elapsed_in_curr) / w)
        weighted = s["prev"] * prev_weight + s["curr"]
        return {"remaining": max(0, math.floor(rule["limit"] - weighted)), "limit": rule["limit"]}


ALGORITHMS = {TokenBucket.name: TokenBucket, SlidingWindow.name: SlidingWindow}
DEFAULT_ALGORITHM = TokenBucket.name


def get_algorithm(name):
    return ALGORITHMS.get(name, ALGORITHMS[DEFAULT_ALGORITHM])
