# Flask port — portability proof

This folder is **not** a second, competing submission. It exists to demonstrate a
design claim made in the main README: *the rate limiter's core is framework-agnostic;
only the adapter is framework-specific.*

The Node version (repo root) is the primary, full-featured implementation (live
dashboard, Swagger, admin API, metrics). This Python/Flask port reuses the **exact same
architecture and config schema** to show the design ports cleanly to another stack with
only the adapter rewritten.

| Layer | Node | Flask | Framework-specific? |
|---|---|---|---|
| Algorithms (token-bucket, sliding-window) | `src/algorithms/` | `ratelimiter/algorithms.py` | No |
| In-memory store (LRU + sweeper) | `src/store.js` | `ratelimiter/store.py` | No |
| Config resolve + hot-reload | `src/config.js` | `ratelimiter/config.py` | No |
| Decision engine | `src/middleware.js` | `ratelimiter/limiter.py` (`check`) | No |
| **Adapter** | `app.use(limiter)` | `before_request` / `after_request` | **Yes — the only glue** |

## Run

```bash
cd flask
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py                 # http://localhost:3001
pytest                        # unit tests for both algorithms
```

## Verify the same behaviour as Node

```bash
# standard write limit = 100 * 0.2 = 20  ->  first 20 ok, then 429
for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code} " \
  -X POST -H "x-api-key: demo-standard-key" -d '{}' http://localhost:3001/api/items; done; echo

# 429 body + Retry-After on the override endpoint (cap 5)
curl -i -s -X POST -H "x-api-key: demo-standard-key" -d '{}' http://localhost:3001/api/expensive
```

Same response contract: `X-RateLimit-{Limit,Remaining,Reset,Scope,Policy}` on every
response, `429` + `Retry-After` + a JSON body when throttled, per-client tiers,
read/write differentiation, per-endpoint overrides, and JSON-config hot-reload.
