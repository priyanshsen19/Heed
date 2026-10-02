import { z } from 'zod';

/** Cursor pagination contract (docs/API.md section 1): keyset cursors only, bounded, no OFFSET. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export const cursorSchema = z.string().min(1).max(512);

export const paginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
