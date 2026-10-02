import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Runtime secrets live in ONE JSON document (docs/DECISIONS.md D-11): one Secret Manager secret in
 * staging and production, one gitignored file locally. They are never separate environment variables
 * and never reach the extension.
 *
 * Stage 1 requires only the security-foundation secrets (data keys, active key id, HMAC pepper), which
 * are real random values. The secrets for features that do not exist yet are optional here and become
 * required in the stage that introduces them (a one-line change plus a test).
 */
const base64Bytes = (minBytes: number) =>
  z.string().refine(
    (value) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return false;
      }
      return Buffer.from(value, 'base64').length >= minBytes;
    },
    `must be base64 encoding of at least ${String(minBytes)} bytes`,
  );

const exactly32Bytes = z
  .string()
  .refine(
    (value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 32,
    'must be base64 encoding of exactly 32 bytes',
  );

export const runtimeSecretsSchema = z
  .object({
    /** AES-256-GCM data keys by key id (Stage 2 uses them; rotation adds ids). */
    DATA_KEYS: z.record(z.string().regex(/^[0-9]{1,3}$/), exactly32Bytes),
    ACTIVE_DATA_KEY_ID: z.string().regex(/^[0-9]{1,3}$/),
    HMAC_PEPPER: base64Bytes(32),
    /** Required from Stage 2 (database). */
    DATABASE_URL: z.string().min(1).optional(),
    /** Required from Stage 3 (authentication). */
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    /** Required from Stage 7 (AI). */
    GEMINI_API_KEY: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!(value.ACTIVE_DATA_KEY_ID in value.DATA_KEYS)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ACTIVE_DATA_KEY_ID'],
        message: 'must reference a key present in DATA_KEYS',
      });
    }
  });

export type RuntimeSecrets = z.infer<typeof runtimeSecretsSchema>;

/**
 * Names of every runtime secret. The extension bundle scan fails if any of these names appears in the
 * built extension, so a leak of even a variable name is caught.
 */
export const RUNTIME_SECRET_NAMES = Object.keys(runtimeSecretsSchema.shape);

/** Generates real random Stage 1 secrets. Used by the local-secrets script and by tests; never hardcode. */
export function generateRuntimeSecrets(): RuntimeSecrets {
  return {
    DATA_KEYS: { '1': randomBytes(32).toString('base64') },
    ACTIVE_DATA_KEY_ID: '1',
    HMAC_PEPPER: randomBytes(32).toString('base64'),
  };
}
