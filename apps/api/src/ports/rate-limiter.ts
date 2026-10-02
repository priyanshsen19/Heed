import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { HttpProblem } from '../http/problem';

/**
 * RATE LIMITER PORT.
 *
 * Production implementation (Stage 2): PostgreSQL-backed counters (`RateLimitCounter`) so limits hold
 * across instances and restarts (docs/ARCHITECTURE.md 4.5, DECISIONS CF-10). A process-local limiter
 * is NOT an acceptable production implementation and must never be added here: with several instances
 * it silently multiplies the limit and it loses state on every restart.
 *
 * Guards: (1) createApp requires a RateLimiter; (2) the only implementation in production code is
 * `UnconfiguredRateLimiter`, which fails closed; (3) test/rate-limiter-port.test.ts fails the build if
 * any other production class implements this interface (the allow-list there is reviewed via CODEOWNERS).
 */
export interface RateLimitRequest {
  /** Stable key such as `ip:1.2.3.4:auth` or `user:<id>:sync`. Never contains secrets or content. */
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

export class RateLimiterNotConfiguredError extends Error {
  override readonly name = 'RateLimiterNotConfiguredError';
}

/** Fails closed until the PostgreSQL-backed limiter exists. Routes that opt in cannot run without it. */
export class UnconfiguredRateLimiter implements RateLimiter {
  consume(_request: RateLimitRequest): Promise<RateLimitDecision> {
    return Promise.reject(
      new RateLimiterNotConfiguredError('No RateLimiter implementation is configured'),
    );
  }
}

export interface RateLimitRouteOptions {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly keyFor: (request: FastifyRequest) => string;
}

/** Integration point: attach as a `preHandler` on routes that need limiting. */
export function rateLimit(
  limiter: RateLimiter,
  options: RateLimitRouteOptions,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    let decision: RateLimitDecision;
    try {
      decision = await limiter.consume({
        key: `${options.name}:${options.keyFor(request)}`,
        limit: options.limit,
        windowMs: options.windowMs,
      });
    } catch (error) {
      request.log.error({ err: error }, 'rate limiter unavailable; failing closed');
      throw new HttpProblem('UPSTREAM_UNAVAILABLE');
    }
    reply.header('ratelimit-remaining', String(Math.max(0, decision.remaining)));
    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpProblem('RATE_LIMITED', undefined, {
        headers: { 'retry-after': String(retryAfterSeconds) },
      });
    }
  };
}

/** Per-IP key helper. `request.ip` honors the configured trust-proxy setting. */
export const ipKey = (request: FastifyRequest): string => `ip:${request.ip}`;
