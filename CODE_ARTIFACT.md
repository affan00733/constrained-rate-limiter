# Code Artifact — Constrained API Rate Limiter

**Full working source (public repository):**
## → https://github.com/affan00733/constrained-rate-limiter

A working proof-of-concept of in-memory, config-driven rate-limiting **middleware**: the
middleware itself, the configuration schema, and a minimal integration example (sample routes).
The repository is the complete, runnable artifact; this document is the entry point to it.

---

## What's inside

```
server.js                      demo app: one app.use(limiter) + sample routes (no per-route limit code)
config/ratelimit.config.json   the entire policy (tiers, limits, overrides) — the config schema
src/
  middleware.js                Express adapter — the only framework-specific file
  config.js                    config load / resolve / hot-reload
  store.js                     in-memory Map store (LRU cap + idle sweeper) — no Redis/DB
  metrics.js                   in-memory counters + Prometheus exposition
  admin.js                     runtime control API
  openapi.js                   OpenAPI 3 spec (served as Swagger UI)
  algorithms/
    tokenBucket.js             default algorithm (burst-tolerant)
    slidingWindow.js           alternative algorithm (smooth)
    index.js                   registry
public/index.html              live dashboard (self-contained)
test/
  algorithms.test.js           unit tests (node --test) — 8 passing
  loadtest.js                  traffic generator that proves the limits
flask/                         Python/Flask port of the same core (portability proof) — 7 pytest passing
```

## Run it (Node — primary)

```bash
git clone https://github.com/affan00733/constrained-rate-limiter
cd constrained-rate-limiter
npm install
npm start            # API + dashboard + Swagger on http://localhost:3000
npm test             # unit tests (8 passing)
npm run loadtest     # fires traffic, prints the limit table below (server must be running)
```

Open **http://localhost:3000/dashboard** to fire traffic and watch buckets drain and 429s in
real time; **http://localhost:3000/docs** for interactive Swagger.

## Run it (Flask — portability proof)

```bash
cd flask
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py        # http://localhost:3001
pytest               # 7 passing
```

---

## Proof it works (`npm run loadtest`)

```
standard GET  /api/items   x130  (read limit 100)   200=100  429= 30  limit=100  retryAfter=1
standard POST /api/items   x30   (write limit 20)   200= 20  429= 10  limit= 20  retryAfter=3
premium  POST /api/items   x30   (write limit 100)  200= 30  429=  0  limit=100  retryAfter=-
anon-IP  POST /api/expensive x8  (override limit 5)  200=  5  429=  3  limit=  5  retryAfter=12
```

This single run demonstrates **per-client tiers** (premium absorbs what standard rejects),
**read-vs-write differentiation** (writes at 0.2× of reads), **per-endpoint overrides**, and
**`429` + `Retry-After`**.

## Where to look first
| To see… | Open |
|---|---|
| The one-line, middleware-only integration | `server.js` (the `app.use(limiter)` line) |
| Per-client + per-endpoint decision logic | `src/config.js` → `resolve()` |
| The token-bucket algorithm | `src/algorithms/tokenBucket.js` → `consume()` |
| The config schema you tune (no code change) | `config/ratelimit.config.json` |

Design rationale, trade-offs, failure modes, and the AI usage log are in the repository's
[`README.md`](https://github.com/affan00733/constrained-rate-limiter/blob/main/README.md).
