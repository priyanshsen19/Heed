import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { AppDependencies } from './deps';
import { registerCors } from './http/cors';
import { installProblemHandlers, sendProblem } from './http/problem';
import { genReqId } from './http/request-id';
import { installSecurityHeaders } from './http/security-headers';
import { healthRoutes } from './routes/health';
import { internalRoutes } from './routes/internal';
import { v1Routes } from './routes/v1';

const BODY_LIMIT_BYTES = 64 * 1024;
const TICK_BUDGET_MS = 4 * 60 * 1000;

/**
 * `buildApp` assembles the application without finalizing it (tests use it to add probe routes before
 * `ready()`); `createApp` is the finalized instance every caller outside tests uses. It performs no I/O of its own, reads no environment, never opens a
 * network port (see startServer), and holds no state beyond what is injected, so any number of
 * identical instances can run side by side and tests can drive it with `app.inject`.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const logger: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance: logger,
    // Fastify's built-in request lines are off; the onResponse hook below logs safe metadata only.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: false,
    genReqId,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: deps.config.trustProxy,
    forceCloseConnections: 'idle',
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installProblemHandlers(app);
  installSecurityHeaders(app);

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  // Only route patterns are logged, never raw URLs or query strings (they can carry tokens).
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        route: request.routeOptions.url ?? '(unmatched)',
        method: request.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  // @fastify/cors registers a wildcard `OPTIONS *` route and Fastify's router is shared across plugin
  // contexts, so without this more specific route a preflight to /internal/* would be answered by the
  // CORS scope. Internal endpoints are never CORS-enabled.
  app.options('/internal/*', (_request, reply) => sendProblem(reply, 'NOT_FOUND'));

  const isDraining = deps.isDraining ?? (() => false);

  // Browser-facing scope: CORS applies here only.
  await app.register(async (scope) => {
    await registerCors(scope, deps.config);
    healthRoutes(scope, { readinessChecks: deps.readinessChecks, isDraining });
    await scope.register(
      async (v1) => {
        v1Routes(v1);
        await Promise.resolve();
      },
      { prefix: '/v1' },
    );
  });

  // Scheduler-facing scope: no CORS, OIDC required. Absent verifier means the endpoint does not exist.
  if (deps.oidcVerifier !== undefined) {
    const verifier = deps.oidcVerifier;
    await app.register(async (scope) => {
      internalRoutes(scope, {
        verifier,
        handlers: deps.tickHandlers ?? [],
        clock: deps.clock,
        processingEnabled: deps.config.processingEnabled,
        tickBudgetMs: TICK_BUDGET_MS,
      });
      await Promise.resolve();
    });
  }

  return app;
}

export async function createApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = await buildApp(deps);
  await app.ready();
  return app;
}
