import type { RateLimitDecision, RateLimitRequest, RateLimiter } from '../ports/rate-limiter';

/**
 * TEST DOUBLE. Returns scripted decisions and records the requests it received. It is not a limiter:
 * it counts nothing. Never wire it into production code (lint and dependency rules forbid imports of
 * `testing/` from production files).
 */
export class ScriptedRateLimiter implements RateLimiter {
  readonly requests: RateLimitRequest[] = [];
  #decisions: RateLimitDecision[];
  readonly #fallback: RateLimitDecision;

  constructor(decisions: RateLimitDecision[] = [], fallback?: RateLimitDecision) {
    this.#decisions = [...decisions];
    this.#fallback = fallback ?? { allowed: true, remaining: 100, retryAfterMs: 0 };
  }

  consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.requests.push(request);
    return Promise.resolve(this.#decisions.shift() ?? this.#fallback);
  }
}
