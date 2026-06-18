"""Demo Flask API protected by the rate-limiting middleware.

The integration is one line: `RateLimiter(...).init_app(app)`. The business
routes below contain NO rate-limit code — the limiter runs as a before_request
middleware across every route (the "middleware-only, not per-route" requirement).
"""

import os

from flask import Flask, jsonify, request

from ratelimiter import RateLimiter

app = Flask(__name__)

CONFIG_PATH = os.environ.get("RATELIMIT_CONFIG", os.path.join(os.path.dirname(__file__), "ratelimit.config.json"))
limiter = RateLimiter(CONFIG_PATH).init_app(app)


# ── business routes (unaware of rate limiting) ───────────────────────────────
@app.get("/api/items")
def list_items():
    return jsonify(items=[{"id": 1}, {"id": 2}])


@app.post("/api/items")
def create_item():
    return jsonify(created=True, body=request.get_json(silent=True)), 201


@app.post("/api/expensive")
def expensive():
    return jsonify(ran=True)


@app.get("/health")
def health():
    return jsonify(status="ok")


# ── minimal ops endpoints (exempt via config skipPrefixes) ───────────────────
def _admin_ok():
    required = limiter.cfg["admin"].get("token")
    return not required or request.headers.get("x-admin-token") == required


@app.get("/admin/stats")
def admin_stats():
    if not _admin_ok():
        return jsonify(error="unauthorized"), 401
    return jsonify(algorithm=limiter.cfg["algorithm"], tracked_keys=limiter.store.size, tiers=limiter.cfg["tiers"])


@app.post("/admin/reset")
def admin_reset():
    if not _admin_ok():
        return jsonify(error="unauthorized"), 401
    client = (request.get_json(silent=True) or {}).get("client")
    removed = limiter.store.delete_by_prefix(client)
    return jsonify(reset=True, client=client or "ALL", buckets_removed=removed)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3001))
    print(f"Flask rate-limited API on http://localhost:{port}")
    app.run(port=port, threaded=True)
