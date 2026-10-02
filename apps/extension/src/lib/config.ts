import { parsePublicConfig, type PublicConfig } from '@heed/shared';

export type ConfigResult =
  | { readonly ok: true; readonly config: PublicConfig }
  | { readonly ok: false; readonly error: string };

/**
 * Resolves the extension's public configuration (API origin and environment name). Public values only:
 * the build rejects anything else (vite.config.ts reads only VITE_-prefixed variables).
 */
export function loadPublicConfig(
  env: Readonly<Record<string, unknown>> = import.meta.env,
): ConfigResult {
  try {
    return {
      ok: true,
      config: parsePublicConfig({
        VITE_API_BASE_URL: env['VITE_API_BASE_URL'],
        VITE_ENV: env['VITE_ENV'],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid public configuration',
    };
  }
}
