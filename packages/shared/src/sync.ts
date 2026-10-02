import { z } from 'zod';
import { cursorSchema } from './pagination';

/** Scaffolding for the extension delta feed (docs/API.md section 7). Entity payloads arrive in later stages. */
export const SYNC_DEFAULT_LIMIT = 100;
export const SYNC_MAX_LIMIT = 200;
export const SYNC_POLL_MIN_SECONDS = 60;
export const SYNC_POLL_MAX_SECONDS = 1800;

export const syncQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(SYNC_MAX_LIMIT).default(SYNC_DEFAULT_LIMIT),
  })
  .strict();

export type SyncQuery = z.infer<typeof syncQuerySchema>;

export const syncEnvelopeSchema = z.object({
  nextCursor: cursorSchema,
  hasMore: z.boolean(),
  resyncRequired: z.boolean(),
  pollAfterSeconds: z.number().int().min(SYNC_POLL_MIN_SECONDS).max(SYNC_POLL_MAX_SECONDS),
  serverTime: z.string(),
});

export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>;
