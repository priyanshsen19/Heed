import { describe, expect, it } from 'vitest';
import { problemDetailsSchema } from '@heed/shared';
import { createApp } from '../src/app';
import { buildHarness } from '../src/testing/test-deps';

describe('GET /healthz', () => {
  it('reports the process is alive without consulting any dependency', async () => {
    let consulted = false;
    const { deps } = buildHarness({
      readinessChecks: [
        {
          name: 'database',
          check: () => {
            consulted = true;
            return Promise.resolve(false);
          },
        },
      ],
    });
    const app = await createApp(deps);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(consulted).toBe(false);
    await app.close();
  });
});

describe('GET /readyz', () => {
  it('is ready when every required check passes', async () => {
    const { deps } = buildHarness({
      readinessChecks: [{ name: 'runtime-secrets', check: () => Promise.resolve(true) }],
    });
    const app = await createApp(deps);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('is ready with no checks registered', async () => {
    const app = await createApp(buildHarness().deps);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await app.close();
  });

  it('is not ready (503) when a check fails, with a constant body and details only in logs', async () => {
    const { deps, logs } = buildHarness({
      readinessChecks: [
        { name: 'runtime-secrets', check: () => Promise.resolve(true) },
        { name: 'database', check: () => Promise.resolve(false) },
      ],
    });
    const app = await createApp(deps);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
    expect(res.body).not.toContain('database');
    expect(logs.text()).toContain('database');
    await app.close();
  });

  it('treats a throwing check as not ready without leaking the error', async () => {
    const { deps } = buildHarness({
      readinessChecks: [
        {
          name: 'database',
          check: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
        },
      ],
    });
    const app = await createApp(deps);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('ECONNREFUSED');
    await app.close();
  });

  it('is not ready while the instance is draining (graceful shutdown)', async () => {
    let draining = false;
    const { deps } = buildHarness({ isDraining: () => draining });
    const app = await createApp(deps);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    draining = true;
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    // liveness is unaffected by draining
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('API versioning', () => {
  it('has no product endpoints in Stage 1 and no /api/v1 prefix', async () => {
    const app = await createApp(buildHarness().deps);
    for (const url of ['/v1/tasks', '/v1/me', '/api/v1/tasks', '/tasks', '/v1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(problemDetailsSchema.safeParse(res.json()).success, url).toBe(true);
    }
    await app.close();
  });

  it('keeps operational endpoints unversioned, as documented', async () => {
    const app = await createApp(buildHarness().deps);
    expect((await app.inject({ method: 'GET', url: '/v1/healthz' })).statusCode).toBe(404);
    await app.close();
  });
});
