/**
 * Time is an injected dependency. Business code never calls `new Date()` or `Date.now()` directly
 * (enforced by lint); it receives a Clock so deadlines, expiry, TTLs, scheduling, and retention are
 * deterministic under test. `SystemClock` is the only production implementation; `FakeClock` lives in
 * `@heed/shared/testing` so production code cannot import it by accident.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }
}
