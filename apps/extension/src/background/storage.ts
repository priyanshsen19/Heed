import { z } from 'zod';

/**
 * Typed, validated access to chrome.storage.local. This module is the ONLY place the extension
 * reads or writes persistent state, and every key has a strict schema, so credentials that must never
 * live in the browser cannot be stored by accident:
 *
 *  - no Google access or refresh tokens, no Gemini or other API keys, no database or server secrets
 *  - the single credential allowed is the Heed-scoped OPAQUE session token (docs/SECURITY.md section 6)
 *
 * Unknown keys are rejected on write; invalid stored values are discarded on read.
 */
/**
 * The Heed session token has one exact shape (docs/SECURITY.md section 6): 32 random bytes encoded as
 * unpadded base64url, i.e. exactly 43 characters. Enforcing the exact format rejects every Google
 * access/refresh token, API key, and client secret by construction (their shapes differ), without this
 * file ever naming those secret formats (which would trip the bundle scan).
 */
const HEED_SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const authSchema = z
  .object({
    sessionToken: z.string().regex(HEED_SESSION_TOKEN, 'must be an opaque Heed session token'),
    idleExpiresAt: z.iso.datetime(),
    absoluteExpiresAt: z.iso.datetime(),
  })
  .strict();

export const STORAGE_SCHEMAS = {
  auth: authSchema,
  schemaVersion: z.number().int().min(1),
  'ui.prefs': z.object({ lastTab: z.enum(['upcoming', 'review', 'history']).optional() }).strict(),
} as const;

export type StorageKey = keyof typeof STORAGE_SCHEMAS;
export type StorageValue<K extends StorageKey> = z.infer<(typeof STORAGE_SCHEMAS)[K]>;

export const CURRENT_SCHEMA_VERSION = 1;

function schemaFor(key: string): z.ZodType {
  if (!Object.hasOwn(STORAGE_SCHEMAS, key)) {
    throw new Error(`Refusing to access unknown storage key: ${key}`);
  }
  return STORAGE_SCHEMAS[key as StorageKey];
}

export async function readItem<K extends StorageKey>(key: K): Promise<StorageValue<K> | undefined> {
  const schema = schemaFor(key);
  const record: Record<string, unknown> = await chrome.storage.local.get(key);
  const stored = record[key];
  if (stored === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(stored);
  if (!parsed.success) {
    // Corrupt or foreign data: drop it rather than trust it.
    await chrome.storage.local.remove(key);
    return undefined;
  }
  return parsed.data as StorageValue<K>;
}

export async function writeItem<K extends StorageKey>(
  key: K,
  value: StorageValue<K>,
): Promise<void> {
  const parsed = schemaFor(key).parse(value);
  await chrome.storage.local.set({ [key]: parsed });
}

export async function removeItem(key: StorageKey): Promise<void> {
  schemaFor(key);
  await chrome.storage.local.remove(key);
}

/** Sign-out, "delete my data", and account deletion clear everything the extension holds. */
export async function clearLocalState(): Promise<void> {
  await chrome.storage.local.clear();
}
