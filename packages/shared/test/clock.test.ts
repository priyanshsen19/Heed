import { describe, expect, it } from 'vitest';
import { SystemClock } from '../src';
import { FakeClock } from '../src/testing';

describe('Clock', () => {
  it('SystemClock returns real, increasing-or-equal time', () => {
    const clock = new SystemClock();
    const a = clock.nowMs();
    const b = clock.nowMs();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('FakeClock is deterministic and controllable', () => {
    const clock = new FakeClock('2026-10-07T11:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-07T11:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-07T11:01:00.000Z');
    clock.set(0);
    expect(clock.nowMs()).toBe(0);
  });

  it('FakeClock returns a fresh Date each call (no shared mutable state)', () => {
    const clock = new FakeClock(1000);
    const first = clock.now();
    first.setTime(5);
    expect(clock.nowMs()).toBe(1000);
  });

  it('FakeClock rejects invalid input', () => {
    expect(() => new FakeClock('not a date')).toThrow(TypeError);
    expect(() => {
      new FakeClock(1).advance(Number.NaN);
    }).toThrow(TypeError);
  });
});
