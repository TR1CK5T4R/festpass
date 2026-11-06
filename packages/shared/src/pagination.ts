import { z } from 'zod';

/** `?cursor=&limit=` for every list endpoint. Query strings arrive as text, so limit is coerced. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Every paginated list returns its items plus the cursor for the next page (null on the last page). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
