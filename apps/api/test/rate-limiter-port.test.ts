import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { problemDetailsSchema } from '@heed/shared';
import { buildApp } from '../src/app';
import {
  RateLimiterNotConfiguredError,
  UnconfiguredRateLimiter,
  ipKey,
  rateLimit,
} from '../src/ports/rate-limiter';
import { ScriptedRateLimiter } from '../src/testing/test-rate-limiter';
import { buildHarness } from '../src/testing/test-deps';

async function appWithLimitedRoute(limiter: ScriptedRateLimiter | UnconfiguredRateLimiter) {
  const harness = buildHarness({ rateLimiter: limiter });
  const app = await buildApp(harness.deps);
  app.get(
    '/probe/limited',
    {
      preHandler: rateLimit(limiter, { name: 'probe', limit: 5, windowMs: 60_000, keyFor: ipKey }),
    },
    () => ({ ok: true }),
  );
  await app.ready();
  return { app, ...harness };
}

describe('RateLimiter integration point', () => {
  it('passes a namespaced key, limit, and window to the limiter and allows the request', async () => {
    const limiter = new ScriptedRateLimiter();
    const { app } = await appWithLimitedRoute(limiter);
    const res = await app.inject({ method: 'GET', url: '/probe/limited' });
    expect(res.statusCode).toBe(200);
    expect(limiter.requests).toHaveLength(1);
    expect(limiter.requests[0]).toMatchObject({ limit: 5, windowMs: 60_000 });
    expect(limiter.requests[0]?.key).toMatch(/^probe:ip:/);
    await app.close();
  });

  it('answers a denied request with RATE_LIMITED and Retry-After', async () => {
    const limiter = new ScriptedRateLimiter([
      { allowed: false, remaining: 0, retryAfterMs: 12_300 },
    ]);
    const { app } = await appWithLimitedRoute(limiter);
    const res = await app.inject({ method: 'GET', url: '/probe/limited' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('13');
    expect(problemDetailsSchema.parse(res.json()).code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('FAILS CLOSED when no real limiter is configured (never silently unlimited)', async () => {
    const { app } = await appWithLimitedRoute(new UnconfiguredRateLimiter());
    const res = await app.inject({ method: 'GET', url: '/probe/limited' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await app.close();
  });

  it('UnconfiguredRateLimiter rejects with a typed error', async () => {
    await expect(
      new UnconfiguredRateLimiter().consume({ key: 'k', limit: 1, windowMs: 1 }),
    ).rejects.toBeInstanceOf(RateLimiterNotConfiguredError);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('guard: no process-local rate limiter can become the production implementation', () => {
  const srcRoot = join(import.meta.dirname, '../src');
  /** Reviewed allow-list (CODEOWNERS). A future PostgreSQL-backed limiter is added here deliberately. */
  const ALLOWED = new Map([
    ['ports/rate-limiter.ts', ['UnconfiguredRateLimiter']],
    ['testing/test-rate-limiter.ts', ['ScriptedRateLimiter']],
  ]);

  it('only the reviewed classes implement RateLimiter', () => {
    const found = new Map<string, string[]>();
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/class\s+(\w+)\s+implements\s+[^{]*\bRateLimiter\b/g)) {
        const key = relative(srcRoot, file);
        found.set(key, [...(found.get(key) ?? []), match[1] ?? '']);
      }
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(ALLOWED));
  });

  it('production code never imports the test double', () => {
    for (const file of sourceFiles(srcRoot)) {
      if (relative(srcRoot, file).startsWith('testing/')) {
        continue;
      }
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /ScriptedRateLimiter|testing\/test-rate-limiter/,
      );
    }
  });
});
