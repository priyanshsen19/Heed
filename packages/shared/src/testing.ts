import type { Clock } from './clock';

/** Deterministic clock for tests. Import only from test files (lint-enforced). */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Date | number | string = '2026-01-01T00:00:00.000Z') {
    this.#ms = FakeClock.toMs(start);
  }

  private static toMs(value: Date | number | string): number {
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(ms)) {
      throw new TypeError('FakeClock: invalid start time');
    }
    return ms;
  }

  now(): Date {
    return new Date(this.#ms);
  }

  nowMs(): number {
    return this.#ms;
  }

  set(to: Date | number | string): void {
    this.#ms = FakeClock.toMs(to);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new TypeError('FakeClock: invalid advance');
    }
    this.#ms += ms;
  }
}
