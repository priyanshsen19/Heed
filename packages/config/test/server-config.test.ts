import { describe, expect, it } from 'vitest';
import { ConfigError, SERVER_CONFIG_VARIABLE_NAMES, loadServerConfig } from '../src';

const EXT = 'chrome-extension://' + 'a'.repeat(32);

const stagingEnv = {
  HEED_ENV: 'staging',
  CORS_ALLOWED_ORIGINS: EXT,
  SERVICE_URL: 'https://heed-api-staging-abc.a.run.app',
  SCHEDULER_SA_EMAIL: 'scheduler@project.iam.gserviceaccount.com',
};

describe('loadServerConfig', () => {
  it('fails closed when HEED_ENV is missing', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/HEED_ENV/);
  });

  it('accepts a minimal local config with defaults', () => {
    const config = loadServerConfig({ HEED_ENV: 'local' });
    expect(config).toMatchObject({
      env: 'local',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      corsAllowedOrigins: [],
      processingEnabled: true,
      trustProxy: false,
    });
  });

  it('rejects malformed values', () => {
    expect(() => loadServerConfig({ HEED_ENV: 'prod' })).toThrow(ConfigError);
    expect(() => loadServerConfig({ HEED_ENV: 'local', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadServerConfig({ HEED_ENV: 'local', PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadServerConfig({ HEED_ENV: 'local', LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadServerConfig({ HEED_ENV: 'local', MIN_CLIENT_VERSION: '1.0' })).toThrow(
      /MIN_CLIENT_VERSION/,
    );
    expect(() => loadServerConfig({ HEED_ENV: 'local', PROCESSING_ENABLED: 'yes' })).toThrow(
      /PROCESSING_ENABLED/,
    );
  });

  it('accepts a complete staging config', () => {
    const config = loadServerConfig(stagingEnv);
    expect(config.corsAllowedOrigins).toEqual([EXT]);
    expect(config.serviceUrl).toBe('https://heed-api-staging-abc.a.run.app');
  });

  it('requires explicit CORS origins, SERVICE_URL and SCHEDULER_SA_EMAIL in staging and production', () => {
    for (const env of ['staging', 'production']) {
      expect(() =>
        loadServerConfig({ ...stagingEnv, HEED_ENV: env, CORS_ALLOWED_ORIGINS: '' }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
      const { SERVICE_URL: _s, ...noService } = stagingEnv;
      expect(() => loadServerConfig({ ...noService, HEED_ENV: env })).toThrow(/SERVICE_URL/);
      const { SCHEDULER_SA_EMAIL: _e, ...noSa } = stagingEnv;
      expect(() => loadServerConfig({ ...noSa, HEED_ENV: env })).toThrow(/SCHEDULER_SA_EMAIL/);
    }
  });

  it('forbids wildcard CORS in every environment (unsafe API configuration)', () => {
    for (const env of ['local', 'test', 'staging', 'production']) {
      expect(() =>
        loadServerConfig({ ...stagingEnv, HEED_ENV: env, CORS_ALLOWED_ORIGINS: '*' }),
      ).toThrow(/wildcard/);
      expect(() =>
        loadServerConfig({
          ...stagingEnv,
          HEED_ENV: env,
          CORS_ALLOWED_ORIGINS: 'https://*.example.com',
        }),
      ).toThrow(/wildcard/);
    }
  });

  it('allows only chrome-extension origins in staging/production, plus localhost in local/test', () => {
    expect(() =>
      loadServerConfig({ ...stagingEnv, CORS_ALLOWED_ORIGINS: 'https://evil.example.com' }),
    ).toThrow(/only chrome-extension/);
    expect(() =>
      loadServerConfig({
        ...stagingEnv,
        HEED_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      }),
    ).toThrow(/only chrome-extension/);
    const local = loadServerConfig({
      HEED_ENV: 'local',
      CORS_ALLOWED_ORIGINS: `http://localhost:5173, ${EXT}`,
    });
    expect(local.corsAllowedOrigins).toEqual(['http://localhost:5173', EXT]);
    expect(() =>
      loadServerConfig({ HEED_ENV: 'local', CORS_ALLOWED_ORIGINS: 'https://evil.example.com' }),
    ).toThrow();
  });

  it('requires an https SERVICE_URL outside local/test', () => {
    expect(() =>
      loadServerConfig({ ...stagingEnv, SERVICE_URL: 'http://insecure.example.com' }),
    ).toThrow(/SERVICE_URL/);
  });

  it('never echoes values in errors', () => {
    try {
      loadServerConfig({ HEED_ENV: 'local', PORT: 'hunter2-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('hunter2-secret-value');
    }
  });

  it('exposes the variable names for the extension bundle scan', () => {
    expect(SERVER_CONFIG_VARIABLE_NAMES).toContain('CORS_ALLOWED_ORIGINS');
    expect(SERVER_CONFIG_VARIABLE_NAMES).toContain('SCHEDULER_SA_EMAIL');
  });
});
