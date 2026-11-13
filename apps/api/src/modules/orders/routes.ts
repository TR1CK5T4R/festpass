import { createOrderSchema, eventIdParamsSchema, idempotencyHeadersSchema } from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/events/:eventId/orders. */
export function orderRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.post(
    '/',
    requireAuth,
    validate({
      params: eventIdParamsSchema,
      headers: idempotencyHeadersSchema,
      body: createOrderSchema,
    }),
    controller.create,
  );
  return router;
}
