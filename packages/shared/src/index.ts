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

// Internal imports end in .ts (rewritten to .js on build) because the web app's bundler reads this
// package as TypeScript source and, unlike tsc and tsx, does not map ./auth.js to auth.ts.
export * from './auth.ts';
export * from './orgs.ts';
export * from './permissions.ts';
export * from './pagination.ts';
export * from './events.ts';
export * from './uploads.ts';
export * from './money.ts';
export * from './orders.ts';
