import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SECURITY_HEADERS } from '../src/http/security-headers';
import { buildHarness } from '../src/testing/test-deps';

describe('security headers', () => {
  it('are set on success, not-found, and error responses', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness.deps);
    app.get('/probe/boom', () => {
      throw new Error('boom');
    });
    await app.ready();
    for (const url of ['/healthz', '/readyz', '/nope', '/probe/boom']) {
      const res = await app.inject({ method: 'GET', url });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers[name], `${url} ${name}`).toBe(value);
      }
      expect(res.headers['x-powered-by'], url).toBeUndefined();
    }
    await app.close();
  });

  it('disables caching and framing and does not interfere with JSON', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness.deps);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
