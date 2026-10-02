import { z } from 'zod';

/**
 * Public configuration: the ONLY configuration the extension may receive. Nothing here is secret.
 * Server configuration and runtime secrets live in `@heed/config`, which the extension must never import.
 */
export const PUBLIC_ENVIRONMENTS = ['local', 'test', 'staging', 'production'] as const;
export type PublicEnvironment = (typeof PUBLIC_ENVIRONMENTS)[number];

export const PUBLIC_CONFIG_VARIABLE_NAMES = ['VITE_API_BASE_URL', 'VITE_ENV'] as const;

const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export const publicConfigSchema = z
  .object({
    VITE_API_BASE_URL: z.url(),
    VITE_ENV: z.enum(PUBLIC_ENVIRONMENTS),
  })
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value.VITE_API_BASE_URL);
    } catch {
      return;
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['VITE_API_BASE_URL'],
        message: 'must not contain credentials',
      });
    }
    const isLocalOrigin = LOCAL_HOSTS.includes(url.hostname);
    if (value.VITE_ENV === 'staging' || value.VITE_ENV === 'production') {
      if (url.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['VITE_API_BASE_URL'],
          message: 'must use https outside local and test environments',
        });
      }
    } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalOrigin)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VITE_API_BASE_URL'],
        message: 'http is allowed only for localhost',
      });
    }
  });

export interface PublicConfig {
  /** Origin only (scheme, host, port). The API prefix is added by the client. */
  readonly apiOrigin: string;
  readonly env: PublicEnvironment;
}

/** Throws a safe error (variable names and rule messages only, never values). */
export function parsePublicConfig(input: Record<string, unknown>): PublicConfig {
  const result = publicConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid public configuration: ${issues}`);
  }
  return {
    apiOrigin: new URL(result.data.VITE_API_BASE_URL).origin,
    env: result.data.VITE_ENV,
  };
}
