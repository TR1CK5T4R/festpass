import { eventIdParamsSchema } from '@festpass/shared';
import { Router } from 'express';
import { byUser, rateLimit, type Limit } from '../../lib/rate-limit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/events/:eventId/queue. */
export function queueRoutes(joinLimit: Limit): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, validate({ params: eventIdParamsSchema }));
  router.post('/join', rateLimit({ name: 'queue-join', keyFn: byUser, ...joinLimit }), controller.join);
  router.get('/status', controller.status);
  return router;
}
