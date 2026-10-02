import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildHarness } from '../src/testing/test-deps';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request ids', () => {
  it('generates a UUID when none is supplied, and differs per request', async () => {
    const app = await createApp(buildHarness().deps);
    const a = await app.inject({ method: 'GET', url: '/healthz' });
    const b = await app.inject({ method: 'GET', url: '/healthz' });
    expect(a.headers['x-request-id']).toMatch(UUID);
    expect(b.headers['x-request-id']).toMatch(UUID);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    await app.close();
  });

  it('propagates a safe caller-supplied id to the response, the logs, and error bodies', async () => {
    const { deps, logs } = buildHarness();
    const app = await createApp(deps);
    const id = 'client-req-0001-abcdef';
    const ok = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': id },
    });
    expect(ok.headers['x-request-id']).toBe(id);
    const missing = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': id },
    });
    expect(missing.json()).toMatchObject({ requestId: id });
    const logged = logs.records().filter((r) => r['requestId'] === id);
    expect(logged.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['spaces', 'has some spaces in it'],
    ['markup', '<script>alert(1)</script>'],
    ['newline injection', 'abcdefgh\r\nSet-Cookie: x=1'],
  ])('replaces an unsafe id (%s) instead of propagating it', async (_label, unsafe) => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': unsafe },
    });
    expect(res.headers['x-request-id']).toMatch(UUID);
    await app.close();
  });

  it('is only a correlation aid: it grants nothing', async () => {
    const app = await createApp(buildHarness().deps);
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'administrator-1234' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
