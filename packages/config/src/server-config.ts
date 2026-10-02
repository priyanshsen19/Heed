import { z } from 'zod';
import { ConfigError, describeIssues } from './errors';

export const HEED_ENVS = ['local', 'test', 'staging', 'production'] as const;
export type HeedEnv = (typeof HEED_ENVS)[number];

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOCAL_HTTP_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const csv = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const booleanString = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const serverConfigEnvSchema = z.object({
  HEED_ENV: z.enum(HEED_ENVS),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ALLOWED_ORIGINS: csv,
  SERVICE_URL: z.url().optional(),
  SCHEDULER_SA_EMAIL: z.email().optional(),
  MIN_CLIENT_VERSION: z.string().regex(SEMVER).default('0.0.0'),
  PROCESSING_ENABLED: booleanString(true),
  TRUST_PROXY: booleanString(false),
});

/** Names of every server configuration variable (none is secret, but none may reach the extension). */
export const SERVER_CONFIG_VARIABLE_NAMES = Object.keys(serverConfigEnvSchema.shape);

export interface ServerConfig {
  readonly env: HeedEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Exact origins allowed by CORS. Wildcards are impossible by construction. */
  readonly corsAllowedOrigins: readonly string[];
  /** OIDC audience for /internal/* (the public URL of this service). */
  readonly serviceUrl: string | undefined;
  /** The only service-account identity allowed to call /internal/*. */
  readonly schedulerServiceAccountEmail: string | undefined;
  readonly minClientVersion: string;
  readonly processingEnabled: boolean;
  readonly trustProxy: boolean;
}

function validateOrigins(env: HeedEnv, origins: readonly string[], ctx: z.RefinementCtx): void {
  const strict = env === 'staging' || env === 'production';
  if (strict && origins.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ALLOWED_ORIGINS'],
      message: 'must list at least one explicit origin in staging and production',
    });
  }
  for (const origin of origins) {
    const isExtension = CHROME_EXTENSION_ORIGIN.test(origin);
    const isLocal = LOCAL_HTTP_ORIGIN.test(origin);
    if (origin.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'wildcard origins are forbidden',
      });
    } else if (strict && !isExtension) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'only chrome-extension://<id> origins are allowed in staging and production',
      });
    } else if (!isExtension && !isLocal) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'origins must be chrome-extension://<id> or http://localhost[:port] in local/test',
      });
    }
  }
}

/**
 * Parses server configuration from an explicit environment map. This function never reads
 * `process.env`; the single entry point (apps/api/src/main.ts) passes it in. Fails closed.
 */
export function loadServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const parsed = serverConfigEnvSchema
    .superRefine((value, ctx) => {
      validateOrigins(value.HEED_ENV, value.CORS_ALLOWED_ORIGINS, ctx);
      if (value.HEED_ENV === 'staging' || value.HEED_ENV === 'production') {
        if (value.SERVICE_URL === undefined || !value.SERVICE_URL.startsWith('https://')) {
          ctx.addIssue({
            code: 'custom',
            path: ['SERVICE_URL'],
            message: 'must be an https URL in staging and production',
          });
        }
        if (value.SCHEDULER_SA_EMAIL === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['SCHEDULER_SA_EMAIL'],
            message: 'is required in staging and production',
          });
        }
      }
    })
    .safeParse(env);

  if (!parsed.success) {
    throw new ConfigError(`Invalid server configuration: ${describeIssues(parsed.error)}`);
  }

  const v = parsed.data;
  return {
    env: v.HEED_ENV,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    corsAllowedOrigins: v.CORS_ALLOWED_ORIGINS,
    serviceUrl: v.SERVICE_URL,
    schedulerServiceAccountEmail: v.SCHEDULER_SA_EMAIL,
    minClientVersion: v.MIN_CLIENT_VERSION,
    processingEnabled: v.PROCESSING_ENABLED,
    trustProxy: v.TRUST_PROXY,
  };
}
