import { batchCheckinSchema, checkinSchema, eventIdParamsSchema } from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireEventPermission } from '../../middleware/require-event-permission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/events/:eventId/checkins. Same order as org routes: params, permission, body. */
export function checkinRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.use(
    requireAuth,
    validate({ params: eventIdParamsSchema }),
    requireEventPermission('checkin:scan'),
  );
  router.get('/manifest', controller.manifest);
  router.post('/', validate({ body: checkinSchema }), controller.checkIn);
  router.post('/batch', validate({ body: batchCheckinSchema }), controller.batch);
  return router;
}
