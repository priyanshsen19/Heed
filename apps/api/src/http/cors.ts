import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '@heed/config';

export const CORS_ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'if-match',
  'idempotency-key',
  'x-request-id',
  'x-heed-client',
] as const;

/**
 * CORS allows only the explicitly configured origins (never `*`; configuration validation rejects
 * wildcards). No credentials mode is used: the API authenticates with an explicit Bearer header.
 * A missing Origin (non-browser callers) is simply not a CORS request. A disallowed origin gets no
 * Access-Control-* headers, so browsers refuse to expose the response. Not an authentication control.
 */
export async function registerCors(app: FastifyInstance, config: ServerConfig): Promise<void> {
  const allowed = new Set(config.corsAllowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: ['x-request-id', 'retry-after'],
    credentials: false,
    maxAge: 600,
  });
}
