import { z } from 'zod';

// Schemas here are used by both the API (validate middleware) and the web app, so they agree on every rule.

/** `?cursor=&limit=` for every list endpoint. Query strings arrive as text, so limit is coerced. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Route params that are a single UUID, e.g. `/events/:id`. */
export const idParamsSchema = z.object({ id: z.uuid() });

/** Every API error has this shape. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
  };
}
