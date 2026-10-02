import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildHarness } from '../src/testing/test-deps';

describe('structured request logging', () => {
  it('emits one JSON record per request with safe metadata only', async () => {
    const { deps, logs } = buildHarness();
    const app = await createApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'req-correlation-0001' },
    });
    expect(res.statusCode).toBe(200);

    const record = logs.records().find((r) => r['msg'] === 'request completed');
    expect(record).toMatchObject({
      requestId: 'req-correlation-0001',
      route: '/healthz',
      method: 'GET',
      status: 200,
      level: 'info',
      severity: 'INFO',
      service: 'heed-api',
      env: 'test',
    });
    expect(typeof record?.['durationMs']).toBe('number');
    expect(typeof record?.['time']).toBe('string');
    expect(Object.keys(record ?? {}).sort()).toEqual(
      [
        'durationMs',
        'env',
        'level',
        'method',
        'msg',
        'requestId',
        'route',
        'service',
        'severity',
        'status',
        'time',
      ].sort(),
    );
    await app.close();
  });

  it('logs the route pattern, and "(unmatched)" for unknown routes, never the raw URL', async () => {
    const { deps, logs } = buildHarness();
    const app = await createApp(deps);
    await app.inject({ method: 'GET', url: '/some/unknown/path?x=1' });
    const record = logs.records().find((r) => r['msg'] === 'request completed');
    expect(record?.['route']).toBe('(unmatched)');
    expect(record?.['status']).toBe(404);
    await app.close();
  });

  it('every line is valid JSON', async () => {
    const { deps, logs } = buildHarness();
    const app = await createApp(deps);
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/nope' });
    for (const line of logs.text().split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    await app.close();
  });
});
