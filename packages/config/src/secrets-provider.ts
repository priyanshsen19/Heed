import { readFile } from 'node:fs/promises';
import { ConfigError, describeIssues } from './errors';
import { runtimeSecretsSchema, type RuntimeSecrets } from './runtime-secrets';

/**
 * The only way business code obtains secrets. Implementations resolve and validate; they never log
 * values and never put values in error messages.
 *
 * V1 implementation: `JsonSecretsProvider` reads the single runtime JSON document. In Cloud Run the
 * document is injected from Secret Manager by the platform (secret-backed environment variable or
 * mounted volume) when the instance starts, so no Secret Manager client library is needed. A future
 * `SecretManagerSecretsProvider` can implement this interface without touching callers.
 */
export interface SecretsProvider {
  getRuntimeSecrets(): Promise<RuntimeSecrets>;
}

export type SecretsSource =
  | { readonly kind: 'json'; readonly json: string }
  | { readonly kind: 'file'; readonly path: string };

export class JsonSecretsProvider implements SecretsProvider {
  readonly #source: SecretsSource;
  /** Per-instance memo of the parsed document: a cache (safe to lose), never business state. */
  #cached: Promise<RuntimeSecrets> | undefined;

  constructor(source: SecretsSource) {
    this.#source = source;
  }

  getRuntimeSecrets(): Promise<RuntimeSecrets> {
    this.#cached ??= this.#load();
    return this.#cached;
  }

  async #load(): Promise<RuntimeSecrets> {
    let raw: string;
    if (this.#source.kind === 'json') {
      raw = this.#source.json;
    } else {
      try {
        raw = await readFile(this.#source.path, 'utf8');
      } catch {
        throw new ConfigError('Runtime secrets file could not be read');
      }
    }

    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new ConfigError('Runtime secrets are not valid JSON');
    }

    const parsed = runtimeSecretsSchema.safeParse(document);
    if (!parsed.success) {
      throw new ConfigError(`Invalid runtime secrets: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
  }
}

/**
 * Chooses the secrets source from explicit environment pointers (not from secret values):
 * `HEED_RUNTIME_SECRETS_FILE` (path) or `HEED_RUNTIME_SECRETS_JSON` (document). Fails closed when
 * neither is provided.
 */
export function createSecretsProvider(
  env: Readonly<Record<string, string | undefined>>,
): SecretsProvider {
  const file = env['HEED_RUNTIME_SECRETS_FILE'];
  const json = env['HEED_RUNTIME_SECRETS_JSON'];
  if (file !== undefined && file !== '') {
    return new JsonSecretsProvider({ kind: 'file', path: file });
  }
  if (json !== undefined && json !== '') {
    return new JsonSecretsProvider({ kind: 'json', json });
  }
  throw new ConfigError(
    'No runtime secrets source: set HEED_RUNTIME_SECRETS_FILE or HEED_RUNTIME_SECRETS_JSON',
  );
}
