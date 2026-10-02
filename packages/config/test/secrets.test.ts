import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  JsonSecretsProvider,
  RUNTIME_SECRET_NAMES,
  createSecretsProvider,
  generateRuntimeSecrets,
  runtimeSecretsSchema,
} from '../src';

describe('runtime secrets schema', () => {
  it('accepts generated secrets (real random values, none hardcoded)', () => {
    expect(runtimeSecretsSchema.safeParse(generateRuntimeSecrets()).success).toBe(true);
  });

  it('generates different secrets each time', () => {
    expect(generateRuntimeSecrets().HMAC_PEPPER).not.toBe(generateRuntimeSecrets().HMAC_PEPPER);
  });

  it('rejects an ACTIVE_DATA_KEY_ID that is not in DATA_KEYS', () => {
    const secrets = { ...generateRuntimeSecrets(), ACTIVE_DATA_KEY_ID: '2' };
    expect(runtimeSecretsSchema.safeParse(secrets).success).toBe(false);
  });

  it('rejects short keys and unknown fields', () => {
    const good = generateRuntimeSecrets();
    expect(
      runtimeSecretsSchema.safeParse({
        ...good,
        DATA_KEYS: { '1': Buffer.alloc(16).toString('base64') },
      }).success,
    ).toBe(false);
    expect(runtimeSecretsSchema.safeParse({ ...good, SURPRISE: 'x' }).success).toBe(false);
  });

  it('lists every secret name for the bundle scan', () => {
    expect(RUNTIME_SECRET_NAMES).toEqual(
      expect.arrayContaining([
        'DATA_KEYS',
        'HMAC_PEPPER',
        'DATABASE_URL',
        'GOOGLE_CLIENT_SECRET',
        'GEMINI_API_KEY',
      ]),
    );
  });
});

describe('SecretsProvider', () => {
  it('resolves from inline JSON', async () => {
    const secrets = generateRuntimeSecrets();
    const provider = new JsonSecretsProvider({ kind: 'json', json: JSON.stringify(secrets) });
    await expect(provider.getRuntimeSecrets()).resolves.toEqual(secrets);
  });

  it('resolves from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heed-secrets-'));
    try {
      const path = join(dir, 'secrets.json');
      const secrets = generateRuntimeSecrets();
      await writeFile(path, JSON.stringify(secrets));
      const provider = createSecretsProvider({ HEED_RUNTIME_SECRETS_FILE: path });
      await expect(provider.getRuntimeSecrets()).resolves.toEqual(secrets);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed with no source', () => {
    expect(() => createSecretsProvider({})).toThrow(ConfigError);
    expect(() => createSecretsProvider({ HEED_RUNTIME_SECRETS_JSON: '' })).toThrow(ConfigError);
  });

  it('fails closed on invalid JSON, invalid shape, and missing files, without leaking values', async () => {
    const leaky = 'super-secret-token-value-abc123';
    await expect(
      new JsonSecretsProvider({ kind: 'json', json: `{not json ${leaky}` }).getRuntimeSecrets(),
    ).rejects.toThrow(/not valid JSON/);
    const bad = new JsonSecretsProvider({
      kind: 'json',
      json: JSON.stringify({ HMAC_PEPPER: leaky }),
    });
    await expect(bad.getRuntimeSecrets()).rejects.toThrow(ConfigError);
    await expect(bad.getRuntimeSecrets()).rejects.not.toThrow(new RegExp(leaky));
    await expect(
      new JsonSecretsProvider({
        kind: 'file',
        path: '/nonexistent/heed/secrets.json',
      }).getRuntimeSecrets(),
    ).rejects.toThrow(/could not be read/);
  });

  it('memoizes the parsed document per instance (cache only)', async () => {
    const provider = new JsonSecretsProvider({
      kind: 'json',
      json: JSON.stringify(generateRuntimeSecrets()),
    });
    expect(await provider.getRuntimeSecrets()).toBe(await provider.getRuntimeSecrets());
  });
});
