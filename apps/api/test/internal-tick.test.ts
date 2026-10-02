import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { problemDetailsSchema } from '@heed/shared';
import { createApp } from '../src/app';
import { GoogleOidcVerifier } from '../src/ports/oidc';
import type { TickHandler } from '../src/ports/tick';
import { TEST_EXTENSION_ORIGIN, buildHarness, testConfig } from '../src/testing/test-deps';

const AUDIENCE = 'https://heed-api-staging-abc.a.run.app';
const SERVICE_ACCOUNT = 'scheduler@heed-staging.iam.gserviceaccount.com';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let privateKey: SigningKey;
let verifierKeys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  verifierKeys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'test-key' }],
  });
});

async function token(
  clockMs: number,
  overrides: {
    claims?: JWTPayload;
    issuer?: string;
    audience?: string;
    expiresInSec?: number;
    key?: SigningKey;
    alg?: string;
  } = {},
): Promise<string> {
  const iat = Math.floor(clockMs / 1000);
  return new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true, ...overrides.claims })
    .setProtectedHeader({ alg: overrides.alg ?? 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? 'https://accounts.google.com')
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (overrides.expiresInSec ?? 3600))
    .sign(overrides.key ?? privateKey);
}

function build(
  opts: { handlers?: TickHandler[]; processing?: 'true' | 'false'; withVerifier?: boolean } = {},
) {
  const harness = buildHarness({
    config: testConfig({
      SERVICE_URL: AUDIENCE,
      SCHEDULER_SA_EMAIL: SERVICE_ACCOUNT,
      PROCESSING_ENABLED: opts.processing ?? 'true',
    }),
  });
  const verifier = new GoogleOidcVerifier({
    audience: AUDIENCE,
    allowedServiceAccountEmail: SERVICE_ACCOUNT,
    clock: harness.clock,
    keys: verifierKeys,
  });
  const deps = {
    ...harness.deps,
    ...(opts.withVerifier === false ? {} : { oidcVerifier: verifier }),
    tickHandlers: opts.handlers ?? [],
  };
  return { ...harness, deps };
}

const post = (app: Awaited<ReturnType<typeof createApp>>, authorization?: string) =>
  app.inject({
    method: 'POST',
    url: '/internal/tick',
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  });

describe('POST /internal/tick (OIDC-protected scheduler endpoint)', () => {
  it('accepts a valid token for the configured service account and audience, and runs handlers', async () => {
    const ran: string[] = [];
    const h = build({
      handlers: [
        {
          name: 'noop',
          run: () => {
            ran.push('noop');
            return Promise.resolve();
          },
        },
      ],
    });
    const app = await createApp(h.deps);
    const res = await post(app, `Bearer ${await token(h.clock.nowMs())}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', handlersRun: 1, processing: 'enabled' });
    expect(ran).toEqual(['noop']);
    await app.close();
  });

  it('is an authenticated no-op in Stage 1 (empty handler registry)', async () => {
    const h = build();
    const app = await createApp(h.deps);
    const res = await post(app, `Bearer ${await token(h.clock.nowMs())}`);
    expect(res.json()).toMatchObject({ handlersRun: 0 });
    await app.close();
  });

  it('does not run handlers while processing is disabled (kill switch)', async () => {
    const ran: string[] = [];
    const h = build({
      processing: 'false',
      handlers: [
        {
          name: 'x',
          run: () => {
            ran.push('x');
            return Promise.resolve();
          },
        },
      ],
    });
    const app = await createApp(h.deps);
    const res = await post(app, `Bearer ${await token(h.clock.nowMs())}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handlersRun: 0, processing: 'disabled' });
    expect(ran).toEqual([]);
    await app.close();
  });

  describe('rejects with a generic 401 and never runs handlers', () => {
    const cases: [string, (ms: number) => Promise<string | undefined>][] = [
      ['no Authorization header', () => Promise.resolve(undefined)],
      ['not a Bearer header', () => Promise.resolve('Basic abc')],
      ['garbage token', () => Promise.resolve('Bearer not.a.jwt')],
      [
        'wrong issuer',
        async (ms) => `Bearer ${await token(ms, { issuer: 'https://evil.example.com' })}`,
      ],
      [
        'wrong audience',
        async (ms) => `Bearer ${await token(ms, { audience: 'https://other.example.com' })}`,
      ],
      ['expired', async (ms) => `Bearer ${await token(ms, { expiresInSec: -10 })}`],
      [
        'wrong service account',
        async (ms) =>
          `Bearer ${await token(ms, { claims: { email: 'attacker@evil.iam.gserviceaccount.com' } })}`,
      ],
      [
        'unverified email',
        async (ms) => `Bearer ${await token(ms, { claims: { email_verified: false } })}`,
      ],
      [
        'missing email claim',
        async (ms) => `Bearer ${await token(ms, { claims: { email: undefined } })}`,
      ],
      [
        'signed by an unknown key',
        async (ms) => {
          const other = await generateKeyPair('RS256');
          return `Bearer ${await token(ms, { key: other.privateKey })}`;
        },
      ],
      [
        'HS256 forged with a shared secret',
        async (ms) => {
          const forged = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
            .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
            .setIssuer('https://accounts.google.com')
            .setAudience(AUDIENCE)
            .setIssuedAt(Math.floor(ms / 1000))
            .setExpirationTime(Math.floor(ms / 1000) + 3600)
            .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
          return `Bearer ${forged}`;
        },
      ],
      [
        'unsigned (alg none)',
        () => {
          const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
          return Promise.resolve(
            `Bearer ${part({ alg: 'none' })}.${part({ iss: 'https://accounts.google.com', aud: AUDIENCE, email: SERVICE_ACCOUNT, email_verified: true })}.`,
          );
        },
      ],
    ];

    it.each(cases)('%s', async (_name, makeHeader) => {
      const ran: string[] = [];
      const h = build({
        handlers: [
          {
            name: 'x',
            run: () => {
              ran.push('x');
              return Promise.resolve();
            },
          },
        ],
      });
      const app = await createApp(h.deps);
      const res = await post(app, await makeHeader(h.clock.nowMs()));
      expect(res.statusCode).toBe(401);
      expect(problemDetailsSchema.parse(res.json()).code).toBe('UNAUTHENTICATED');
      expect(res.body).not.toMatch(/expired|audience|issuer|signature|service account/i);
      expect(ran).toEqual([]);
      await app.close();
    });
  });

  it('expiry is evaluated against the injected clock', async () => {
    const h = build();
    const app = await createApp(h.deps);
    const header = `Bearer ${await token(h.clock.nowMs(), { expiresInSec: 60 })}`;
    expect((await post(app, header)).statusCode).toBe(200);
    h.clock.advance(61_000);
    expect((await post(app, header)).statusCode).toBe(401);
    await app.close();
  });

  it('logs a rejection reason code only, never the token', async () => {
    const h = build();
    const app = await createApp(h.deps);
    const bad = await token(h.clock.nowMs(), { audience: 'https://other.example.com' });
    await post(app, `Bearer ${bad}`);
    const text = h.logs.text();
    expect(text).toContain('internal request rejected');
    expect(text).not.toContain(bad);
    expect(text).not.toContain(bad.split('.')[1] ?? 'x');
    await app.close();
  });

  it('does not exist when no verifier is configured (no anonymous path)', async () => {
    const h = build({ withVerifier: false });
    const app = await createApp(h.deps);
    expect((await post(app)).statusCode).toBe(404);
    await app.close();
  });

  it('is not CORS-enabled even for an allowed origin', async () => {
    const h = build();
    const app = await createApp(h.deps);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: {
        origin: TEST_EXTENSION_ORIGIN,
        authorization: `Bearer ${await token(h.clock.nowMs())}`,
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/internal/tick',
      headers: { origin: TEST_EXTENSION_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(404);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
