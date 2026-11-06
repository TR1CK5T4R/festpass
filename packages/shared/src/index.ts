import { z } from 'zod';

// Schemas here are used by both the API (validate middleware) and the web app, so they agree on every rule.

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

export * from './auth.js';
export * from './orgs.js';
export * from './permissions.js';
export * from './pagination.js';
export * from './events.js';
