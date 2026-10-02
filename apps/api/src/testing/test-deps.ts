import { loadServerConfig, type ServerConfig } from '@heed/config';
import { FakeClock } from '@heed/shared/testing';
import type { AppDependencies } from '../deps';
import { createLogger } from '../observability/logger';
import { createLogCapture, type LogCapture } from './log-capture';
import { ScriptedRateLimiter } from './test-rate-limiter';

export const TEST_EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
export const TEST_OTHER_ORIGIN = 'https://evil.example.com';

export interface TestHarness {
  readonly deps: AppDependencies;
  readonly logs: LogCapture;
  readonly clock: FakeClock;
  readonly rateLimiter: ScriptedRateLimiter;
}

export function testConfig(overrides: Record<string, string> = {}): ServerConfig {
  return loadServerConfig({
    HEED_ENV: 'test',
    CORS_ALLOWED_ORIGINS: TEST_EXTENSION_ORIGIN,
    LOG_LEVEL: 'debug',
    ...overrides,
  });
}

export function buildHarness(overrides: Partial<AppDependencies> = {}): TestHarness {
  const logs = createLogCapture();
  const clock = new FakeClock('2026-10-07T10:00:00.000Z');
  const rateLimiter = new ScriptedRateLimiter();
  const config = overrides.config ?? testConfig();
  const deps: AppDependencies = {
    config,
    clock,
    logger: createLogger({
      level: config.logLevel,
      env: config.env,
      destination: logs.destination,
    }),
    rateLimiter,
    readinessChecks: [],
    ...overrides,
  };
  return { deps, logs, clock, rateLimiter };
}
