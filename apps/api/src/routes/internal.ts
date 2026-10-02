import type { FastifyInstance } from 'fastify';
import type { Clock } from '@heed/shared';
import { HttpProblem } from '../http/problem';
import { OidcVerificationError, type OidcVerifier } from '../ports/oidc';
import type { TickHandler } from '../ports/tick';

export interface InternalRouteOptions {
  readonly verifier: OidcVerifier;
  readonly handlers: readonly TickHandler[];
  readonly clock: Clock;
  readonly processingEnabled: boolean;
  readonly tickBudgetMs: number;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * `/internal/*` is for Cloud Scheduler only: every request must carry a valid Google-signed OIDC
 * token for the configured service account and this service's audience. There is no CORS on this
 * scope and no anonymous path. In Stage 1 the handler registry is empty, so a tick is an authenticated
 * no-op that proves the trust path; real work is added by later stages.
 */
export function internalRoutes(app: FastifyInstance, options: InternalRouteOptions): void {
  app.post('/internal/tick', async (request) => {
    const header = request.headers.authorization;
    const token = header !== undefined ? BEARER.exec(header)?.[1] : undefined;
    if (token === undefined) {
      throw new HttpProblem('UNAUTHENTICATED');
    }
    try {
      await options.verifier.verify(token);
    } catch (error) {
      const reason = error instanceof OidcVerificationError ? error.reason : 'error';
      request.log.warn({ reason }, 'internal request rejected');
      throw new HttpProblem('UNAUTHENTICATED');
    }

    if (!options.processingEnabled) {
      return { status: 'ok' as const, handlersRun: 0, processing: 'disabled' as const };
    }
    for (const handler of options.handlers) {
      await handler.run({ clock: options.clock, budgetMs: options.tickBudgetMs });
    }
    return {
      status: 'ok' as const,
      handlersRun: options.handlers.length,
      processing: 'enabled' as const,
    };
  });
}
