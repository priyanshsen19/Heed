import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  MAX_PAGE_LIMIT,
  PROBLEM_CATALOG,
  isSafeRequestId,
  pageSchema,
  paginationQuerySchema,
  parsePublicConfig,
  problemDetailsSchema,
  problemTypeFor,
  syncQuerySchema,
} from '../src';
import { z } from 'zod';

describe('problem contract', () => {
  it('has a catalog entry (status 4xx/5xx) for every error code', () => {
    for (const code of ERROR_CODES) {
      const entry = PROBLEM_CATALOG[code];
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it('validates a well-formed problem document', () => {
    const parsed = problemDetailsSchema.safeParse({
      type: problemTypeFor('NOT_FOUND'),
      title: PROBLEM_CATALOG.NOT_FOUND.title,
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'req-12345678',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown code', () => {
    expect(
      problemDetailsSchema.safeParse({
        type: 'x',
        title: 'x',
        status: 400,
        code: 'MADE_UP',
        requestId: 'r',
      }).success,
    ).toBe(false);
  });
});

describe('pagination contract', () => {
  it('applies default limit and bounds the maximum', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(50);
    expect(paginationQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('has no OFFSET: unknown keys (offset, page) are rejected', () => {
    expect(paginationQuerySchema.safeParse({ offset: 10 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ page: 2 }).success).toBe(false);
  });

  it('builds a page envelope', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ items: [{ id: 'a' }], nextCursor: null }).success).toBe(true);
    expect(schema.safeParse({ items: [], nextCursor: '' }).success).toBe(false);
  });

  it('bounds the sync feed page size', () => {
    expect(syncQuerySchema.parse({}).limit).toBe(100);
    expect(syncQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe('request id', () => {
  it('accepts only safe ids', () => {
    expect(isSafeRequestId('0f3c2b1a-1111-4222-8333-444455556666')).toBe(true);
    expect(isSafeRequestId('short')).toBe(false);
    expect(isSafeRequestId('has space in it!')).toBe(false);
    expect(isSafeRequestId('a'.repeat(65))).toBe(false);
    expect(isSafeRequestId(undefined)).toBe(false);
    expect(isSafeRequestId('<script>alert(1)</script>')).toBe(false);
  });
});

describe('public config', () => {
  it('parses a valid production config to an origin', () => {
    const config = parsePublicConfig({
      VITE_API_BASE_URL: 'https://api.example.test/some/path',
      VITE_ENV: 'production',
    });
    expect(config).toEqual({ apiOrigin: 'https://api.example.test', env: 'production' });
  });

  it('allows http only for localhost in local/test', () => {
    expect(
      parsePublicConfig({ VITE_API_BASE_URL: 'http://localhost:8787', VITE_ENV: 'local' })
        .apiOrigin,
    ).toBe('http://localhost:8787');
    expect(() =>
      parsePublicConfig({ VITE_API_BASE_URL: 'http://api.example.test', VITE_ENV: 'local' }),
    ).toThrow(/http is allowed only for localhost/);
  });

  it('requires https in staging and production, even for localhost', () => {
    expect(() =>
      parsePublicConfig({ VITE_API_BASE_URL: 'http://localhost:8787', VITE_ENV: 'staging' }),
    ).toThrow(/https/);
  });

  it('rejects credentials in the URL and missing values', () => {
    expect(() =>
      parsePublicConfig({
        VITE_API_BASE_URL: 'https://user:pw@api.example.test',
        VITE_ENV: 'production',
      }),
    ).toThrow(/credentials/);
    expect(() => parsePublicConfig({})).toThrow(/Invalid public configuration/);
  });

  it('never echoes the offending value in its error', () => {
    try {
      parsePublicConfig({
        VITE_API_BASE_URL: 'https://user:SuperSecret123@x.test',
        VITE_ENV: 'production',
      });
    } catch (error) {
      expect(String(error)).not.toContain('SuperSecret123');
    }
  });
});
