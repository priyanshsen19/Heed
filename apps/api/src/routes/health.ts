import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthzResponseSchema, readyzResponseSchema } from '@heed/shared';
import { evaluateReadiness, type ReadinessCheck } from '../ports/readiness';

export interface HealthRouteOptions {
  readonly readinessChecks: readonly ReadinessCheck[];
  readonly isDraining: () => boolean;
}

/**
 * `/healthz`: the process is alive; consults nothing.
 * `/readyz`: required runtime dependencies are available; constant detail-free body (the failing
 * check names go to the logs only). A draining instance reports not ready so traffic moves away.
 * Both are unversioned operational endpoints, as documented in docs/API.md section 10.
 */
export function healthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/healthz', { schema: { response: { 200: healthzResponseSchema } } }, () => ({
    status: 'ok' as const,
  }));

  typed.get(
    '/readyz',
    { schema: { response: { 200: readyzResponseSchema, 503: readyzResponseSchema } } },
    async (request, reply) => {
      if (options.isDraining()) {
        return reply.code(503).send({ status: 'not_ready' as const });
      }
      const result = await evaluateReadiness(options.readinessChecks);
      if (!result.ready) {
        request.log.warn({ failedChecks: result.failed }, 'readiness check failed');
        return reply.code(503).send({ status: 'not_ready' as const });
      }
      return reply.code(200).send({ status: 'ready' as const });
    },
  );
}
