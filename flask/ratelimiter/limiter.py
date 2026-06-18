"""Framework-agnostic limiter core + a thin Flask adapter.

`RateLimiter.check()` is pure (no Flask) — it's the portable decision engine.
`RateLimiter.init_app(app)` is the ONLY Flask-specific code: it registers a
single `before_request` hook (true middleware — it short-circuits with 429 for
every route) and an `after_request` hook to attach the X-RateLimit-* headers.
Sample routes contain zero rate-limit logic.
"""

import math
import os
import threading
import time

from flask import g, jsonify, request

from .algorithms import get_algorithm
from .config import load_config
from .store import InMemoryStore


def now_ms():
    return time.time() * 1000.0


class RateLimiter:
    def __init__(self, config_path):
        self.config_path = config_path
        self.cfg = load_config(config_path)
        self._mtime = os.path.getmtime(config_path)
        self.store = InMemoryStore(self.cfg["store"])
        self._start_sweeper()

    # ── config hot-reload (no restart / no code change) ──────────────────────
    def _maybe_reload(self):
        try:
            mtime = os.path.getmtime(self.config_path)
            if mtime != self._mtime:
                new_cfg = load_config(self.config_path)
                if new_cfg["algorithm"] != self.cfg["algorithm"]:
                    self.store.clear()  # state shapes differ between algorithms
                self.cfg = new_cfg
                self._mtime = mtime
                print("[ratelimit] config reloaded")
        except (OSError, ValueError) as exc:  # bad/locked file: keep previous
            print(f"[ratelimit] reload skipped: {exc}")

    def _start_sweeper(self):
        interval = max(1.0, self.cfg["store"].get("sweepIntervalMs", 30000) / 1000.0)

        def loop():
            while True:
                time.sleep(interval)
                self.store.sweep(now_ms())

        threading.Thread(target=loop, daemon=True).start()

    # ── pure decision engine (no Flask) ──────────────────────────────────────
    def principal_of(self, get_header, remote_addr):
        header = self.cfg["ident"]["header"]
        key = get_header(header)
        if key:
            return {"kind": "key", "id": key}
        if self.cfg["ident"].get("ipFallback"):
            return {"kind": "ip", "id": remote_addr or "unknown"}
        return {"kind": "anon", "id": "anonymous"}

    def check(self, method, path, get_header, remote_addr):
        self._maybe_reload()
        principal = self.principal_of(get_header, remote_addr)
        decision = self.cfg["resolve"](principal, method, path)
        if decision.get("skip"):
            return None
        algo = get_algorithm(self.cfg["algorithm"])
        now = now_ms()
        state = self.store.get_or_create(decision["key"], now, algo.create)
        result = algo.consume(state, decision["rule"], now)
        return {"decision": decision, "result": result, "algo": algo.name}

    # ── Flask glue ───────────────────────────────────────────────────────────
    def _apply_headers(self, resp, decision, result, algo_name):
        resp.headers["X-RateLimit-Limit"] = str(result["limit"])
        resp.headers["X-RateLimit-Remaining"] = str(result["remaining"])
        resp.headers["X-RateLimit-Reset"] = str(math.ceil((now_ms() + result["reset_ms"]) / 1000))
        resp.headers["X-RateLimit-Scope"] = decision["scope"]
        resp.headers["X-RateLimit-Policy"] = algo_name

    def init_app(self, app):
        @app.before_request
        def _rate_limit():
            outcome = self.check(request.method, request.path, request.headers.get, request.remote_addr)
            if outcome is None:
                return None  # exempt path
            g._rl = outcome
            result = outcome["result"]
            decision = outcome["decision"]
            if not result["allowed"]:
                retry = max(1, math.ceil(result["retry_after_ms"] / 1000))
                resp = jsonify(
                    {
                        "error": "rate_limit_exceeded",
                        "message": (
                            f"Rate limit exceeded for {decision['scope']}. "
                            f"Limit is {result['limit']} request(s) per "
                            f"{round(decision['rule']['window_ms'] / 1000)}s."
                        ),
                        "limit": result["limit"],
                        "remaining": 0,
                        "retryAfterSeconds": retry,
                        "scope": decision["scope"],
                        "policy": outcome["algo"],
                    }
                )
                resp.status_code = 429
                resp.headers["Retry-After"] = str(retry)
                self._apply_headers(resp, decision, result, outcome["algo"])
                return resp
            return None

        @app.after_request
        def _rate_limit_headers(resp):
            outcome = getattr(g, "_rl", None)
            if outcome is not None and resp.status_code != 429:
                self._apply_headers(resp, outcome["decision"], outcome["result"], outcome["algo"])
            return resp

        return self
