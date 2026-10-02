import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildProblemForTest } from './problem-fixture';
import { ApiError, createApiClient } from '../src/background/api-client';

const ORIGIN = 'https://api.example.test';
const schema = z.object({ ok: z.boolean() });

function client(fetchFn: typeof fetch, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  return createApiClient({
    apiOrigin: ORIGIN,
    clientVersion: '0.0.1',
    getSessionToken: () => Promise.resolve('S'.repeat(43)),
    fetchFn,
    newRequestId: () => 'req-fixed-0001',
    ...extra,
  });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('API client', () => {
  it('sends versioned, bearer-authenticated, credential-free requests with correlation headers', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(json({ ok: true })));
    const result = await client(fetchFn as unknown as typeof fetch).request({
      method: 'POST',
      path: '/v1/things',
      body: { a: 1 },
      schema,
      idempotencyKey: 'idem-1',
      ifMatch: '"3"',
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`${ORIGIN}/v1/things`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${'S'.repeat(43)}`,
      'x-request-id': 'req-fixed-0001',
      'x-heed-client': 'extension/0.0.1',
      'idempotency-key': 'idem-1',
      'if-match': '"3"',
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{"a":1}');
  });

  it('omits Authorization when signed out', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(json({ ok: true })));
    await client(fetchFn as unknown as typeof fetch, {
      getSessionToken: () => Promise.resolve(undefined),
    }).request({ method: 'GET', path: '/v1/x', schema });
    expect((fetchFn.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).not.toHaveProperty(
      'authorization',
    );
  });

  it.each([
    '/healthz',
    'https://evil.example.com/v1/x',
    '//evil.example.com/v1/x',
    '/v1/../admin',
    '/v2/x',
    'v1/x',
    '/v1//x',
  ])('refuses non-/v1 or off-origin path %s', async (path) => {
    const fetchFn = vi.fn();
    await expect(
      client(fetchFn as unknown as typeof fetch).request({ method: 'GET', path, schema }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('parses problem+json into a typed ApiError carrying the request id', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildProblemForTest('VERSION_CONFLICT', 409)), {
          status: 409,
          headers: { 'content-type': 'application/problem+json', 'x-request-id': 'srv-req-0001' },
        }),
      ),
    );
    const error = await client(fetchFn as unknown as typeof fetch)
      .request({ method: 'PATCH', path: '/v1/x', schema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      requestId: 'srv-req-0001',
    });
  });

  it('notifies the caller when the server rejects the session', async () => {
    const onSessionRejected = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildProblemForTest('SESSION_EXPIRED', 401)), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
    );
    await client(fetchFn as unknown as typeof fetch, { onSessionRejected })
      .request({ method: 'GET', path: '/v1/x', schema })
      .catch(() => undefined);
    expect(onSessionRejected).toHaveBeenCalledOnce();
  });

  it('never puts response bodies or tokens into error messages', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response('<html>secret-body-token-xyz</html>', { status: 500 })),
    );
    const error = (await client(fetchFn as unknown as typeof fetch)
      .request({ method: 'GET', path: '/v1/x', schema })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('secret-body-token-xyz');
  });

  it('maps network failures and timeouts to typed errors', async () => {
    const network = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(
      await client(network as unknown as typeof fetch)
        .request({ method: 'GET', path: '/v1/x', schema })
        .catch((e: unknown) => e),
    ).toMatchObject({ code: 'NETWORK' });
    const timeout = vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    expect(
      await client(timeout as unknown as typeof fetch)
        .request({ method: 'GET', path: '/v1/x', schema })
        .catch((e: unknown) => e),
    ).toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects responses that do not match the expected schema', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(json({ unexpected: 1 })));
    expect(
      await client(fetchFn as unknown as typeof fetch)
        .request({ method: 'GET', path: '/v1/x', schema })
        .catch((e: unknown) => e),
    ).toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('supports 204 responses with a void schema', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(
      client(fetchFn as unknown as typeof fetch).request({
        method: 'DELETE',
        path: '/v1/x',
        schema: z.undefined(),
      }),
    ).resolves.toBeUndefined();
  });
});
