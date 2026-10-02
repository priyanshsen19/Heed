import type { FastifyInstance } from 'fastify';

/**
 * Baseline response headers for a JSON API. None of these interfere with legitimate API use; they
 * stop browsers from sniffing, framing, caching, or leaking referrers from API responses. CORS is a
 * browser-side read policy only and is never relied upon as authentication.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    done(null, payload);
  });
}
