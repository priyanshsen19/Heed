import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { TEST_EXTENSION_ORIGIN, TEST_OTHER_ORIGIN, buildHarness } from '../src/testing/test-deps';

describe('CORS policy', () => {
  it('allows a configured origin on a normal request', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: TEST_EXTENSION_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_EXTENSION_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(res.headers['vary'])).toContain('Origin');
    await app.close();
  });

  it('gives a disallowed origin no CORS grant (and never a wildcard)', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: TEST_OTHER_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('treats a missing Origin as a non-CORS request: served, with no CORS headers', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('answers a preflight from an allowed origin with the documented methods and headers', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_EXTENSION_ORIGIN);
    expect(String(res.headers['access-control-allow-methods'])).toContain('PATCH');
    for (const header of [
      'authorization',
      'content-type',
      'if-match',
      'idempotency-key',
      'x-request-id',
    ]) {
      expect(String(res.headers['access-control-allow-headers'])).toContain(header);
    }
    expect(res.headers['access-control-max-age']).toBe('600');
    await app.close();
  });

  it('gives a preflight from a disallowed origin no allow headers', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: TEST_OTHER_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    await app.close();
  });

  it('does not treat CORS as authentication: a disallowed origin is still just an unauthenticated request', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { origin: TEST_OTHER_ORIGIN },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
