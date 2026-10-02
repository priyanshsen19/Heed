import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, sanitize, scrubString } from '../src/observability/redact';

describe('scrubString', () => {
  it.each([
    ['email address', 'contact jane.doe+tag@acme-corp.example.com now', '[email]'],
    ['bearer token', 'Authorization: Bearer abc.DEF-123_xyz~+/=', 'Bearer [REDACTED]'],
    [
      'jwt',
      'tok ' + 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.sig_abcdef12 end',
      '[jwt]',
    ],
    ['google api key', 'key=' + 'AI' + 'zaSyA-1234567890abcdefghij', '[secret]'],
    ['google client secret', 'GOC' + 'SPX-abcdefghijklmnop', '[secret]'],
    ['google access token', 'ya' + '29.a0AbCdEfGhIjKlMn', '[secret]'],
    ['google refresh token', '1/' + '/0gAbCdEfGhIjKlMnOp', '[secret]'],
    ['postgres url', 'url=post' + 'gres://u:p@db:5432/x?sslmode=require', '[db-url]'],
    ['url credentials', 'https://user:pw@example.com/path', '://[REDACTED]@'],
    [
      'private key',
      '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
      '[private-key]',
    ],
  ])('scrubs %s', (_label, input, marker) => {
    const out = scrubString(input);
    expect(out).toContain(marker);
  });

  it('keeps UUIDs and timestamps intact (correlation data)', () => {
    const uuid = '0f3c2b1a-1111-4222-8333-444455556666';
    expect(scrubString(`req ${uuid} at 2026-10-07T10:00:00.000Z`)).toContain(uuid);
  });

  it('redacts long opaque tokens', () => {
    expect(scrubString('x ' + 'A1b2C3d4'.repeat(6) + ' y')).toContain('[opaque]');
  });

  it('redacts prose-sized text but keeps short messages', () => {
    const prose =
      'Please complete the coding assignment before the interview on Wednesday morning. ' +
      'We look forward to meeting you and discussing the role in detail with the team. '.repeat(2);
    expect(scrubString(prose)).toMatch(/^\[text redacted: \d+ chars\]$/);
    expect(scrubString('request completed')).toBe('request completed');
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'refreshToken',
    'access_token',
    'apiKey',
    'GEMINI_API_KEY',
    'password',
    'client_secret',
    'body',
    'emailBody',
    'requestBody',
    'subject',
    'email',
    'userEmail',
    'from',
    'to',
    'prompt',
    'snippet',
    'quote',
    'sessionToken',
    'cookie',
    'headers',
  ])('flags %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'requestId',
    'route',
    'method',
    'status',
    'durationMs',
    'count',
    'severity',
    'service',
    'handlersRun',
    'reason',
  ])('does not flag %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('sanitize', () => {
  it('redacts sensitive keys and scrubs nested strings, arrays, and errors', () => {
    const out = sanitize({
      route: '/v1/x',
      body: 'secret mail',
      nested: { token: 'abc', note: 'mail jane@acme.test' },
      list: ['jane@acme.test', 1, null],
      err: new Error('failed for jane@acme.test'),
    }) as Record<string, unknown>;
    expect(out['route']).toBe('/v1/x');
    expect(out['body']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['token']).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('jane@acme.test');
    expect((out['err'] as Record<string, unknown>)['message']).toContain('[email]');
  });

  it('is safe on circular, deep, binary, bigint, and function values and never throws', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => sanitize(circular)).not.toThrow();
    expect(JSON.stringify(sanitize(circular))).toContain('[circular]');
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 20; i += 1) {
      deep = { child: deep };
    }
    expect(JSON.stringify(sanitize(deep))).toContain('[truncated]');
    expect(sanitize(Buffer.from('mail body'))).toBe('[binary]');
    expect(sanitize(10n)).toBe('10');
    expect(sanitize(() => 1)).toBeUndefined();
  });

  it('bounds the number of keys and array items', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${String(i)}`, i]));
    expect(Object.keys(sanitize(wide) as object).length).toBeLessThanOrEqual(51);
    expect((sanitize(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });

  it('keeps correlation ids readable even when long', () => {
    const id = 'a'.repeat(60);
    expect((sanitize({ requestId: id }) as Record<string, unknown>)['requestId']).toBe(id);
  });
});
