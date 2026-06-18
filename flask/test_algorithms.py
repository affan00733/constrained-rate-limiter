"""Unit tests for the algorithms (run: `pytest` or `python -m pytest`).
Time is injected, so tests are deterministic — no sleeps."""

from ratelimiter.algorithms import TokenBucket, SlidingWindow


def rule(limit, window_ms=60000, burst=None):
    return {
        "capacity": burst if burst is not None else limit,
        "refill_per_ms": limit / window_ms,
        "limit": limit,
        "window_ms": window_ms,
    }


def test_token_bucket_allows_capacity_then_blocks():
    r = rule(5)
    s = TokenBucket.create(0)
    allowed = sum(1 for _ in range(8) if TokenBucket.consume(s, r, 0)["allowed"])
    assert allowed == 5


def test_token_bucket_refills_over_time():
    r = rule(60, 60000)  # 1 token / 1000ms
    s = TokenBucket.create(0)
    for _ in range(60):
        TokenBucket.consume(s, r, 0)
    assert TokenBucket.consume(s, r, 0)["allowed"] is False
    assert TokenBucket.consume(s, r, 1000)["allowed"] is True


def test_token_bucket_retry_after_positive_when_blocked():
    r = rule(1, 60000)
    s = TokenBucket.create(0)
    assert TokenBucket.consume(s, r, 0)["allowed"] is True
    denied = TokenBucket.consume(s, r, 0)
    assert denied["allowed"] is False
    assert denied["retry_after_ms"] > 0


def test_sliding_window_allows_limit_then_blocks():
    r = rule(10, 1000)
    s = SlidingWindow.create(0)
    allowed = sum(1 for _ in range(15) if SlidingWindow.consume(s, r, 0)["allowed"])
    assert allowed == 10


def test_sliding_window_frees_after_window():
    r = rule(10, 1000)
    s = SlidingWindow.create(0)
    for _ in range(10):
        SlidingWindow.consume(s, r, 0)
    assert SlidingWindow.consume(s, r, 0)["allowed"] is False
    assert SlidingWindow.consume(s, r, 2000)["allowed"] is True


def test_sliding_window_smooths_boundary():
    r = rule(10, 1000)
    s = SlidingWindow.create(0)
    for _ in range(10):
        SlidingWindow.consume(s, r, 0)
    allowed = sum(1 for _ in range(10) if SlidingWindow.consume(s, r, 1000)["allowed"])
    assert allowed < 10  # previous window still weighted -> no full 2x burst


def test_same_interface():
    for algo in (TokenBucket, SlidingWindow):
        r = rule(5)
        s = algo.create(0)
        res = algo.consume(s, r, 0)
        assert {"allowed", "remaining", "retry_after_ms", "reset_ms", "limit"} <= res.keys()
        assert {"remaining", "limit"} <= algo.peek(s, r, 0).keys()
