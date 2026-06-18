/**
 * OpenAPI 3.0 spec, served as interactive Swagger UI at /docs.
 * Documents the business API, the rate-limit response contract (headers + 429),
 * and the admin/ops endpoints.
 */

const rateLimitHeaders = {
  'X-RateLimit-Limit': { schema: { type: 'integer' }, description: 'Requests allowed for this bucket.' },
  'X-RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests left in this bucket.' },
  'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix seconds until the bucket refills.' },
  'X-RateLimit-Scope': { schema: { type: 'string' }, description: 'Which bucket applied (read/write/override).' },
  'X-RateLimit-Policy': { schema: { type: 'string' }, description: 'Active algorithm (token-bucket | sliding-window).' },
};

const tooManyRequests = {
  description: 'Rate limit exceeded.',
  headers: { ...rateLimitHeaders, 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' } },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/RateLimitError' },
      example: {
        error: 'rate_limit_exceeded',
        message: 'Rate limit exceeded for write (standard tier). Limit is 20 request(s) per 60s.',
        limit: 20,
        remaining: 0,
        retryAfterSeconds: 3,
        scope: 'write (standard tier)',
        policy: 'token-bucket',
      },
    },
  },
};

const apiKey = [{ name: 'x-api-key', in: 'header', required: false, schema: { type: 'string' }, description: 'Client credential. Use demo-standard-key or demo-premium-key.' }];
const okHeaders = { headers: rateLimitHeaders };

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Constrained Rate Limiter API',
    version: '2.0.0',
    description:
      'Demo API protected by in-memory, config-driven rate-limiting middleware.\n\n' +
      'Every response carries `X-RateLimit-*` headers; throttled requests get `429` + `Retry-After`.\n' +
      'Tiers: **standard** 100/min, **premium** 500/min. Writes are limited at 0.2x of reads.',
  },
  tags: [
    { name: 'API', description: 'Business endpoints (rate limited via middleware).' },
    { name: 'Admin', description: 'Runtime configuration & control (requires x-admin-token).' },
    { name: 'Ops', description: 'Observability: metrics, live bucket stats.' },
  ],
  paths: {
    '/api/items': {
      get: {
        tags: ['API'], summary: 'List items (read bucket).', parameters: apiKey,
        responses: { 200: { description: 'OK', ...okHeaders }, 429: tooManyRequests },
      },
      post: {
        tags: ['API'], summary: 'Create item (write bucket, stricter).', parameters: apiKey,
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 201: { description: 'Created', ...okHeaders }, 429: tooManyRequests },
      },
    },
    '/api/expensive': {
      post: {
        tags: ['API'], summary: 'Expensive op (per-endpoint override, cap 5/min).', parameters: apiKey,
        responses: { 200: { description: 'OK', ...okHeaders }, 429: tooManyRequests },
      },
    },
    '/health': {
      get: { tags: ['Ops'], summary: 'Liveness (exempt from limiting).', responses: { 200: { description: 'OK' } } },
    },
    '/metrics': {
      get: { tags: ['Ops'], summary: 'Prometheus metrics.', responses: { 200: { description: 'Prometheus text.', content: { 'text/plain': {} } } } },
    },
    '/admin/stats': {
      get: { tags: ['Admin'], summary: 'Live metrics + bucket snapshot.', security: [{ adminToken: [] }], responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } } },
    },
    '/admin/config': {
      get: { tags: ['Admin'], summary: 'Current effective config.', security: [{ adminToken: [] }], responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } } },
    },
    '/admin/tiers/{tier}': {
      patch: {
        tags: ['Admin'], summary: 'Update a tier limit at runtime (no restart).',
        security: [{ adminToken: [] }],
        parameters: [{ name: 'tier', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { limit: { type: 'integer' }, windowMs: { type: 'integer' } } }, example: { limit: 50 } } } },
        responses: { 200: { description: 'Updated' }, 401: { description: 'Unauthorized' } },
      },
    },
    '/admin/algorithm': {
      patch: {
        tags: ['Admin'], summary: 'Switch algorithm at runtime.', security: [{ adminToken: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { algorithm: { type: 'string', enum: ['token-bucket', 'sliding-window'] } } }, example: { algorithm: 'sliding-window' } } } },
        responses: { 200: { description: 'Switched' }, 400: { description: 'Invalid' }, 401: { description: 'Unauthorized' } },
      },
    },
    '/admin/reset': {
      post: {
        tags: ['Admin'], summary: 'Reset a client\'s buckets (or all).', security: [{ adminToken: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { client: { type: 'string' } } }, example: { client: 'key:demo-standard-key' } } } },
        responses: { 200: { description: 'Reset' }, 401: { description: 'Unauthorized' } },
      },
    },
  },
  components: {
    securitySchemes: { adminToken: { type: 'apiKey', in: 'header', name: 'x-admin-token' } },
    schemas: {
      RateLimitError: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          limit: { type: 'integer' },
          remaining: { type: 'integer' },
          retryAfterSeconds: { type: 'integer' },
          scope: { type: 'string' },
          policy: { type: 'string' },
        },
      },
    },
  },
};
