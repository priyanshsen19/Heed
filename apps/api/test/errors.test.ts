import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PROBLEM_CONTENT_TYPE, problemDetailsSchema } from '@heed/shared';
import { buildApp } from '../src/app';
import { HttpProblem } from '../src/http/problem';
import { buildHarness } from '../src/testing/test-deps';

async function appWithProbes() {
  const harness = buildHarness();
  const app = await buildApp(harness.deps);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/probe/validate',
    {
      schema: {
        body: z.object({ title: z.string().min(1).max(10), count: z.number().int() }).strict(),
      },
    },
    () => ({ ok: true }),
  );
  app.get('/probe/boom', () => {
    throw new Error(
      'SELECT * FROM "Task" WHERE secret = \'hunter2\' at /srv/heed/apps/api/src/db.ts:42',
    );
  });
  app.get('/probe/problem', () => {
    throw new HttpProblem('VERSION_CONFLICT', 'The task was changed elsewhere');
  });
  app.get('/probe/unauth', () => {
    throw new HttpProblem('UNAUTHENTICATED');
  });
  typed.get(
    '/probe/bad-response',
    { schema: { response: { 200: z.object({ n: z.number() }) } } },
    () => ({
      n: 'not-a-number' as unknown as number,
    }),
  );
  await app.ready();
  return { app, ...harness };
}

describe('problem+json error model', () => {
  it('answers unknown routes with a documented NOT_FOUND problem', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const body = problemDetailsSchema.parse(res.json());
    expect(body).toMatchObject({ status: 404, code: 'NOT_FOUND', title: 'Resource not found' });
    expect(body.requestId).toBe(res.headers['x-request-id']);
    await app.close();
  });

  it('maps HttpProblem to its documented status, code, and detail', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/probe/problem' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      detail: 'The task was changed elsewhere',
      type: 'urn:heed:problem:VERSION_CONFLICT',
    });
    await app.close();
  });

  it('turns schema validation failures into VALIDATION_FAILED with field paths and no values', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      payload: { title: 'this-title-is-way-too-long-and-secret-value-xyz', count: 'seven' },
    });
    expect(res.statusCode).toBe(400);
    const body = problemDetailsSchema.parse(res.json());
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors?.map((e) => e.path).sort()).toEqual(['count', 'title']);
    expect(res.body).not.toContain('secret-value-xyz');
    await app.close();
  });

  it('rejects unknown body fields (strict schemas)', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      payload: { title: 'ok', count: 1, extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    await app.close();
  });

  it('never exposes stack traces, SQL, secrets, or internal paths on unexpected errors', async () => {
    const { app, logs } = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/probe/boom' });
    expect(res.statusCode).toBe(500);
    const body = problemDetailsSchema.parse(res.json());
    expect(body).toMatchObject({ code: 'INTERNAL', status: 500 });
    for (const forbidden of ['SELECT', 'hunter2', '/srv/heed', 'stack', 'db.ts', 'Error:']) {
      expect(res.body, forbidden).not.toContain(forbidden);
    }
    // internal logs record the failure (scrubbed), so operators can diagnose
    const record = logs.records().find((r) => r['msg'] === 'unhandled error');
    expect(record).toBeDefined();
    await app.close();
  });

  it('hides response-schema bugs behind INTERNAL', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/probe/bad-response' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL' });
    expect(res.body).not.toContain('not-a-number');
    await app.close();
  });

  it('maps malformed JSON to a validation problem', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"title": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    await app.close();
  });

  it('enforces the 64 KB body limit with PAYLOAD_TOO_LARGE', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(70_000), count: 1 }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await app.close();
  });

  it('rejects unsupported media types', async () => {
    const { app } = await appWithProbes();
    const res = await app.inject({
      method: 'POST',
      url: '/probe/validate',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await app.close();
  });

  it('every error response validates against the shared contract', async () => {
    const { app } = await appWithProbes();
    for (const [method, url] of [
      ['GET', '/nope'],
      ['GET', '/probe/boom'],
      ['GET', '/probe/unauth'],
      ['GET', '/probe/problem'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(problemDetailsSchema.safeParse(res.json()).success, url).toBe(true);
    }
    await app.close();
  });
});
