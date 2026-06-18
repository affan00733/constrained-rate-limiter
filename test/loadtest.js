/**
 * Tiny load generator that proves the four behaviours the challenge asks for.
 * Run the server (`npm start`) in one terminal, then `npm test` in another.
 *
 * It uses Node's built-in fetch (Node 18+) — no test dependencies.
 */

const BASE = process.env.BASE || 'http://localhost:3000';

async function fire(n, { method = 'GET', path = '/api/items', key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;

  const out = { ok: 0, limited: 0, limit: null, retryAfter: null };
  for (let i = 0; i < n; i++) {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify({ i }),
    });
    out.limit = res.headers.get('x-ratelimit-limit');
    if (res.status === 429) {
      out.limited++;
      out.retryAfter = res.headers.get('retry-after');
    } else {
      out.ok++;
    }
  }
  return out;
}

function row(label, r) {
  const ok = String(r.ok).padStart(3);
  const limited = String(r.limited).padStart(3);
  console.log(
    `${label.padEnd(48)} 200=${ok}  429=${limited}  limit=${String(r.limit).padStart(3)}  retryAfter=${r.retryAfter ?? '-'}`
  );
}

const scenarios = [
  ['standard GET  /api/items   x130  (read limit 100)', 130, { method: 'GET', path: '/api/items', key: 'demo-standard-key' }],
  ['standard POST /api/items   x30   (write limit 20)', 30, { method: 'POST', path: '/api/items', key: 'demo-standard-key' }],
  ['premium  POST /api/items   x30   (write limit 100)', 30, { method: 'POST', path: '/api/items', key: 'demo-premium-key' }],
  ['anon-IP  POST /api/expensive x8  (override limit 5)', 8, { method: 'POST', path: '/api/expensive' }],
];

console.log(`\nRate limiter demo against ${BASE}`);
console.log('-'.repeat(92));
for (const [label, n, opts] of scenarios) {
  row(label, await fire(n, opts));
}
console.log('-'.repeat(92));

const stats = await (await fetch(`${BASE}/__ratelimit/stats`)).json();
console.log(`buckets held in memory: ${stats.trackedKeys}`);
console.log(
  'Expected: standard read ~100/30, standard write 20/10, premium write 30/0, expensive 5/3.\n'
);
