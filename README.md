# Constrained API Rate Limiter

**📦 Source code:** https://github.com/affan00733/constrained-rate-limiter

In-memory, config-driven rate-limiting **middleware** for an HTTP API — built for the
scenario where one client's automated job consumed ~40% of capacity and degraded service
for everyone else.

- **Primary implementation:** Node.js + Express (repo root) — full-featured, with a live
  dashboard, Swagger docs, runtime admin API, Prometheus metrics, two pluggable algorithms,
  and unit tests.
- **Portability proof:** [`/flask`](flask/README.md) — the same framework-agnostic core
  behind a Flask adapter (language isn't scored; this shows the design ports cleanly).

> **Quick start:** `npm install && npm start` → open http://localhost:3000/dashboard,
> http://localhost:3000/docs. Verify: `npm test` (unit) and `npm run loadtest` (traffic).
> Full run/endpoint/config reference is in the [Appendix](#appendix--operational-reference).

---

# Section A — Architecture & Trade-offs

**Algorithm: token bucket (default), with a sliding-window-counter alternative behind the
same interface.** The incident we're preventing is *sustained* capacity starvation — one
client holding a large share of throughput. Token bucket caps the sustained rate
(refill = limit ÷ window) while permitting a small, bounded burst (the bucket capacity),
which is what legitimate bursty clients need. It costs **O(1) memory per key** — a token
count and a timestamp — so it survives the in-memory-only constraint without the
per-request timestamp log a true sliding-window log would keep. `Retry-After` falls out
exactly as the time to refill the deficit. I kept a **sliding-window counter** switchable
by config for callers who want a strict "no more than N in any rolling 60s" with no burst;
it trades the burst allowance for smoother boundaries at the same O(1) memory.

**How per-client and per-endpoint limiting interact.** Identity resolves first: an
`x-api-key` maps to a tier (standard 100/min, premium 500/min), falling back to client IP.
Then the request's *scope* is chosen: an explicit endpoint override (e.g.
`POST /api/expensive` = 5/min) wins; otherwise the method class applies a multiplier to the
tier limit — writes (POST/PUT/PATCH/DELETE) get 0.2× of reads. The bucket key is
`{identity}|{scope}`, so every client gets **independent read, write, and per-endpoint
buckets**. A flood of writes can't starve that same client's reads, and one tenant's
traffic never touches another's counters. All limits live in a JSON file (hot-reloaded) —
no code change to retune.

**What it handles well / where it breaks down.** Handles well: single-instance fairness,
bursty-but-legitimate clients, precise per-client feedback, zero external dependencies.
Breaks down: it is **per-process** — behind N load-balanced instances the effective limit
is up to N× (see B1). Token bucket also *permits* a full-capacity burst by design — correct
for fairness, wrong if you need a hard instantaneous ceiling (use sliding-window, or set
`burst` < limit). Identity is only as trustworthy as the auth in front of it; this is a
fairness control, **not** a security boundary.

**What I'd change with more time.** A Redis (atomic counter / Lua) store behind the existing
store interface to make limits correct across instances; pattern matching for endpoint
overrides (`/api/users/:id`); and jitter on `Retry-After` to avoid synchronized retry storms.

### Request flow

```
                         HTTP request
                              │
               ┌──────────────▼───────────────┐
               │   app.use(limiter)   (ONE)   │   ← middleware-only, not per-route
               └──────────────┬───────────────┘
                              │
     ┌────────────────────────▼────────────────────────┐
     │ 1. identify principal {kind,id}  (x-api-key→tier, else IP)
     │ 2. resolve scope:  skip? → endpoint override? → read/write × tier
     │ 3. bucket key = {identity}|{scope}
     └────────────────────────┬────────────────────────┘
                              │
               ┌──────────────▼──────────────┐
               │ in-memory store (Map/dict)  │   LRU cap + idle sweeper
               └──────────────┬──────────────┘
                              │ state
               ┌──────────────▼──────────────┐
               │ algorithm.consume()         │   token-bucket | sliding-window
               └──────────────┬──────────────┘
                    allowed?   │
            ┌──────────────────┴───────────────────┐
         yes│                                       │no
            ▼                                       ▼
   next() → route handler              429 + Retry-After + JSON body
   (+ X-RateLimit-* headers)           (+ X-RateLimit-* headers)

   Ops/demo layers (separate, limiter-exempt):  /dashboard  /docs  /admin  /metrics
```

---

# Section B — Production Readiness Plan

## B1 — Failure Modes & Scaling Plan

**(1) Process restart — fresh quotas, acceptable?** All buckets live in memory, so a restart
wipes every counter: each client starts full and can immediately burst to its limit. For
*per-minute* quotas this is acceptable — the blast radius is ≤ one window (60s) of one
instance over-admitting, and deploys are infrequent relative to the window. It would **not**
be acceptable for billing-grade or long-window (hourly/daily) quotas, where the reset is a
real loophole; those need a durable store. (Config changes *are* persisted to JSON, so
retunes survive restarts; counters don't.)

**(2) Multiple server instances — what breaks, what fixes it?** This is the main limitation.
Each instance holds its own counters, so with N instances behind a round-robin load balancer
a client can reach up to **N× its limit** (its requests spread across N independent buckets).
Constraint-friendly stop-gaps: hash/sticky routing by API key so a client always lands on one
instance (limit holds, but instance loss/rebalancing leaks a window), or divide each limit by
N and accept slack. The real fix is **shared state** — Redis with atomic `INCR`/Lua or a Lua
token-bucket — slotted behind the existing store interface: the algorithms and resolver are
untouched, only the store changes.

**(3) Memory growth — when dangerous, what catches it first?** Memory is
O(unique identities × scopes); each bucket is ~tiny, but unbounded distinct identities (IP
fallback, rotated keys) grow it without limit. Guards: an **idle sweeper** evicts buckets
untouched past `maxIdleMs`, and a hard **`maxKeys` cap** LRU-evicts on overflow. It turns
dangerous when the distinct-identity rate outpaces eviction (a key-rotation flood). **First
signal:** the `store.size` gauge (exposed via `/metrics`) — alert on sustained growth or
nearing `maxKeys` (process RSS only lags).

## B2 — Reasoning question (answered without AI assistance)

The plausible-but-wrong answer I actually hit on this build was in how client identity feeds
the tiers. When you ask for "per-client rate limiting with tiers," the natural move — and what
my first version did — is to compute one client identifier, like `key:demo-premium-key`, and
use that *same* string both as the bucket key and as the lookup into the tier table. It reads
cleanly and demos fine: tiers exist, buckets exist, 429s fire on cue.

The trap is that the tier table is keyed by the *raw* API key (`demo-premium-key`), so the
namespaced lookup misses and silently falls through to the default tier. The symptom is
wrong-but-believable: premium clients get `X-RateLimit-Limit: 20` on writes instead of `100`.
Nothing errors, the logs look normal, and a code review won't catch it because the code reads
correctly.

The way I caught it — and the way I'd catch this whole class of bug — is a behavioral test that
asserts the actual numbers: send 30 premium writes and assert that ~30 succeed. The moment it
reports 20, the bug is obvious. The fix is to separate the two concerns: the raw key drives the
tier lookup, and a namespaced version keys the bucket. The general lesson I take from it is that
for limiter logic I trust an assertion on observed counts over reading the code, because this
failure mode is silent and "looks right."

---

# Section C — AI Usage Log

Honest log of the significant AI interactions in this build — what I asked, what the AI
produced, and what I kept / changed / rejected, and why.

**1. "Build the in-memory rate-limiting middleware."**
- *Gave:* a complete Node/Express token-bucket implementation with a config-driven store and
  sweeper — solid structure.
- *Kept:* the architecture (token bucket, in-memory `Map` + idle sweeper, JSON config).
- *Changed / rejected:* I required a behavioral load test before trusting it. The test
  exposed that premium clients were getting standard limits — the AI had used one namespaced
  identity string for *both* the bucket key and the tier lookup (see B2). I had it split
  identity into `principal = {kind, id}`. **Why:** the code read correctly; only an
  assertion on observed counts proved it wrong.

**2. "Make it stand out — add Flask, Swagger, a UI."**
- *Gave:* an offer to rewrite the whole thing in Flask.
- *Changed / rejected:* I kept the already-verified Node core and added the dashboard,
  Swagger, admin API, and metrics as *separate* layers; the Flask version became a scoped
  **portability proof**, not a rewrite. **Why:** language isn't scored ("engineering
  judgment is"), and a working, verified demo de-risks the submission more than a second
  from-scratch stack.

**3. "Generate an AI voiceover/transcript for the video."**
- *Gave:* (could have produced) a polished AI-read narration.
- *Rejected:* the brief explicitly says *don't read an AI-created transcript*, and the video
  scores authentic communication + my real AI-redirection story. **Why:** an AI voiceover
  would actively *lose* the highest-weighted item. I built a timed talking-point outline and
  delivered the walkthrough in my own voice instead.

*(Bonus, minor: a throwaway traffic-generation shell command the AI wrote had a quoting bug
that sent the API key as a malformed header; I caught it because the store showed only 1
bucket instead of 5, and switched the generator to Node's `fetch`.)*

---

# Appendix — Operational Reference

## Run

```bash
npm install
npm start                 # API + dashboard + docs on :3000
npm test                  # unit tests (both algorithms)
npm run loadtest          # traffic demo (server must be running)
```

`npm run loadtest` output:

```
standard GET  /api/items   x130  (read limit 100)   200=100  429= 30  limit=100  retryAfter=1
standard POST /api/items   x30   (write limit 20)   200= 20  429= 10  limit= 20  retryAfter=3
premium  POST /api/items   x30   (write limit 100)  200= 30  429=  0  limit=100  retryAfter=-
anon-IP  POST /api/expensive x8  (override limit 5)  200=  5  429=  3  limit=  5  retryAfter=12
```

Flask port: `cd flask && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py` (port 3001), `pytest`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/items` | read (tier limit) |
| `POST /api/items` | write (0.2× tier limit) |
| `POST /api/expensive` | per-endpoint override (5/min) |
| `GET /health` | liveness (exempt) |
| `/dashboard` | live SSE dashboard — fire traffic, watch buckets/429s |
| `/docs` | Swagger UI |
| `/metrics` | Prometheus metrics |
| `/admin/*` | runtime control (token `x-admin-token`): tier limits, algorithm, reset |

## Response contract

Every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
`X-RateLimit-Scope`, `X-RateLimit-Policy`. Throttled: `429` + `Retry-After` + body:

```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded for override POST /api/expensive. Limit is 5 request(s) per 60s.",
  "limit": 5, "remaining": 0, "retryAfterSeconds": 12,
  "scope": "override POST /api/expensive", "policy": "token-bucket"
}
```

## Configuration (excerpt)

```jsonc
{
  "algorithm": "token-bucket",                 // or "sliding-window"
  "tiers": { "standard": {"limit":100,"windowMs":60000}, "premium": {"limit":500,"windowMs":60000} },
  "clients": { "demo-standard-key": "standard", "demo-premium-key": "premium" },
  "methodMultipliers": { "read": 1.0, "write": 0.2 },
  "endpointOverrides": [ {"method":"POST","path":"/api/expensive","limit":5,"windowMs":60000} ],
  "store": { "sweepIntervalMs":30000, "maxIdleMs":120000, "maxKeys":100000 }
}
```

Resolution order: skip list → endpoint override → read/write class × tier. Edit the file
(hot-reload ~150 ms) or use the admin API; both apply live with no restart.
