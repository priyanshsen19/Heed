import { describe, expect, it } from 'vitest';
import { loadPublicConfig } from '../src/lib/config';

describe('public configuration', () => {
  it('resolves valid public values', () => {
    expect(
      loadPublicConfig({ VITE_API_BASE_URL: 'https://api.example.test', VITE_ENV: 'production' }),
    ).toEqual({
      ok: true,
      config: { apiOrigin: 'https://api.example.test', env: 'production' },
    });
  });

  it('reports invalid configuration without throwing or echoing values', () => {
    const result = loadPublicConfig({
      VITE_API_BASE_URL: 'http://api.example.test',
      VITE_ENV: 'production',
    });
    expect(result.ok).toBe(false);
    expect(loadPublicConfig({}).ok).toBe(false);
  });

  it('ignores every non-public variable even if present in the environment object', () => {
    const result = loadPublicConfig({
      VITE_API_BASE_URL: 'https://api.example.test',
      VITE_ENV: 'staging',
      GEMINI_API_KEY: 'should-never-be-read',
      DATABASE_URL: 'should-never-be-read',
    });
    expect(JSON.stringify(result)).not.toContain('should-never-be-read');
  });
});
