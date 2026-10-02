/**
 * Process entry point and the ONLY module allowed to read `process.env` (lint-enforced). It resolves
 * configuration and secrets once, builds the dependency graph, and starts the server. Anything that
 * is missing or malformed makes the process exit before it accepts a single request (fail closed).
 */
import { ConfigError, createSecretsProvider, loadServerConfig } from '@heed/config';
import { SystemClock } from '@heed/shared';
import { startServer } from './server';
import { createLogger } from './observability/logger';
import { GoogleOidcVerifier } from './ports/oidc';
import { UnconfiguredRateLimiter } from './ports/rate-limiter';
import type { ReadinessCheck } from './ports/readiness';

const DRAIN_DELAY_MS = 3000;

async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const secrets = createSecretsProvider(process.env);
  await secrets.getRuntimeSecrets(); // validates the secret document at boot

  const clock = new SystemClock();
  const logger = createLogger({ level: config.logLevel, env: config.env });

  const readinessChecks: ReadinessCheck[] = [
    {
      name: 'runtime-secrets',
      async check() {
        await secrets.getRuntimeSecrets();
        return true;
      },
    },
  ];

  const oidcVerifier =
    config.serviceUrl !== undefined && config.schedulerServiceAccountEmail !== undefined
      ? new GoogleOidcVerifier({
          audience: config.serviceUrl,
          allowedServiceAccountEmail: config.schedulerServiceAccountEmail,
          clock,
        })
      : undefined;

  const server = await startServer({
    config,
    clock,
    logger,
    // Stage 2 replaces this with the PostgreSQL-backed limiter; until then limiting fails closed.
    rateLimiter: new UnconfiguredRateLimiter(),
    readinessChecks,
    ...(oidcVerifier !== undefined ? { oidcVerifier } : {}),
  });

  logger.info({ port: config.port }, 'heed-api started');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown requested; draining');
    server.drain();
    setTimeout(() => {
      server
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    }, DRAIN_DELAY_MS);
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // Safe startup failure line: ConfigError messages list variable names only, never values.
  const reason =
    error instanceof ConfigError ? error.message : error instanceof Error ? error.name : 'unknown';
  process.stderr.write(
    `${JSON.stringify({ severity: 'CRITICAL', msg: 'startup failed', reason })}\n`,
  );
  process.exit(1);
});
