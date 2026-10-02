import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createLogger } from '../src/observability/logger';
import { createLogCapture } from '../src/testing/log-capture';
import { buildHarness } from '../src/testing/test-deps';

/**
 * LOG CANARY. Synthetic values standing in for the things that must NEVER be logged: an email body,
 * an email address, OAuth access/refresh tokens, an API key, a bearer token, a database URL, a prompt.
 * They are pushed through the logger in every shape a developer might use, plus through real HTTP
 * requests. If ANY canary reaches the output, this test fails and CI fails. Values are assembled from
 * fragments at runtime so the test file itself holds no realistic secret.
 */
const CANARIES = {
  emailBody:
    'CANARY_BODY Hi Sam, please complete the coding assignment before the interview on Wednesday at 11 AM. Reply to the recruiter if anything is unclear and we will schedule a follow-up call afterwards.',
  emailAddress: 'canary.recruiter' + '@' + 'acme-canary.example',
  accessToken: 'ya' + '29.CANARYaccessTokenValue0123456789',
  refreshToken: '1/' + '/0gCANARYrefreshTokenValue0123456789',
  apiKey: 'AI' + 'zaSyCANARYapiKeyValue0123456789abcdef',
  bearer: 'CANARYbearerValue.abc-123_xyz',
  dbUrl: 'post' + 'gres://canaryuser:canarypass@db.canary.internal:5432/heed',
  prompt:
    'CANARY_PROMPT You extract tasks. The message is: please wire the money to account 12345.',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJjYW5hcnkiOiJ2YWx1ZSJ9' + '.CANARYsignature0123456789',
};

const FRAGMENTS = [
  'CANARY_BODY',
  'canary.recruiter',
  'acme-canary.example',
  'CANARYaccessTokenValue',
  'CANARYrefreshTokenValue',
  'CANARYapiKeyValue',
  'CANARYbearerValue',
  'canarypass',
  'canaryuser',
  'CANARY_PROMPT',
  'CANARYsignature',
  'wire the money',
];

function expectNoCanary(output: string): void {
  for (const fragment of FRAGMENTS) {
    expect(output, `leaked: ${fragment}`).not.toContain(fragment);
  }
  for (const value of Object.values(CANARIES)) {
    expect(output).not.toContain(value);
  }
}

describe('log canary: sensitive values never reach log output', () => {
  it('under well-known keys, odd keys, nesting, arrays, and in message strings', () => {
    const logs = createLogCapture();
    const log = createLogger({ level: 'trace', env: 'test', destination: logs.destination });

    log.info(
      { body: CANARIES.emailBody, email: CANARIES.emailAddress, token: CANARIES.accessToken },
      'fields',
    );
    log.info({
      emailBody: CANARIES.emailBody,
      refreshToken: CANARIES.refreshToken,
      apiKey: CANARIES.apiKey,
    });
    log.info({
      headers: { authorization: `Bearer ${CANARIES.bearer}` },
      nested: { deeper: { prompt: CANARIES.prompt } },
    });
    log.info({ list: [CANARIES.emailAddress, CANARIES.accessToken, { dbUrl: CANARIES.dbUrl }] });
    // innocuous keys: the VALUE layer must still catch these
    log.info({
      foo: `to ${CANARIES.emailAddress}`,
      bar: CANARIES.accessToken,
      baz: CANARIES.apiKey,
      qux: CANARIES.dbUrl,
      jwt: CANARIES.jwt,
    });
    log.info({ detail: CANARIES.emailBody }); // prose under an innocuous key
    log.warn(`user ${CANARIES.emailAddress} sent ${CANARIES.refreshToken} with ${CANARIES.apiKey}`);
    log.error(
      {
        err: new Error(
          `failed: ${CANARIES.dbUrl} for ${CANARIES.emailAddress} using ${CANARIES.accessToken}`,
        ),
      },
      'boom',
    );
    log.error(new Error(`direct error ${CANARIES.refreshToken}`));
    log.debug({ cause: new Error('outer', { cause: new Error(`inner ${CANARIES.apiKey}`) }) });

    expect(logs.records().length).toBeGreaterThanOrEqual(10);
    expectNoCanary(logs.text());
  });

  it('through real requests: headers, bodies, query strings, request.log, and thrown errors', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness.deps);
    app.post('/probe/echo', (request) => {
      request.log.info({ body: request.body, emailBody: CANARIES.emailBody }, 'handling');
      request.log.warn(`got ${CANARIES.emailAddress}`);
      throw new Error(`handler failed with ${CANARIES.refreshToken} and ${CANARIES.dbUrl}`);
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/probe/echo?token=${CANARIES.accessToken}&email=${CANARIES.emailAddress}`,
      headers: {
        authorization: `Bearer ${CANARIES.bearer}`,
        cookie: `session=${CANARIES.refreshToken}`,
        'content-type': 'application/json',
      },
      payload: {
        subject: CANARIES.emailAddress,
        text: CANARIES.emailBody,
        apiKey: CANARIES.apiKey,
      },
    });
    expect(res.statusCode).toBe(500);
    expectNoCanary(harness.logs.text());
    expectNoCanary(res.body); // the error response must not leak either
    await app.close();
  });

  it('does not log request URLs or query strings at all', async () => {
    const harness = buildHarness();
    const app = await buildApp(harness.deps);
    await app.ready();
    await app.inject({ method: 'GET', url: '/healthz?access_token=CANARYqueryTokenValue123456' });
    await app.inject({ method: 'GET', url: '/does/not/exist/CANARYpathSecretValue123' });
    const text = harness.logs.text();
    expect(text).not.toContain('CANARYqueryTokenValue');
    expect(text).not.toContain('CANARYpathSecretValue');
    expect(text).not.toContain('access_token');
    await app.close();
  });
});
