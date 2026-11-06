import {
  createEventSchema,
  createTierSchema,
  eventParamsSchema,
  eventSlugParamsSchema,
  orgParamsSchema,
  paginationQuerySchema,
  publicEventsQuerySchema,
  tierParamsSchema,
  updateEventSchema,
  updateTierSchema,
} from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOrgPermission } from '../../middleware/require-org-permission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/orgs/:orgId/events. Same order as org routes: params, permission, then body. */
export function orgEventRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);
  const event = validate({ params: eventParamsSchema });
  const tier = validate({ params: tierParamsSchema });

  router.post(
    '/',
    validate({ params: orgParamsSchema }),
    requireOrgPermission('event:create'),
    validate({ body: createEventSchema }),
    controller.create,
  );
  router.get(
    '/',
    validate({ params: orgParamsSchema, query: paginationQuerySchema }),
    requireOrgPermission('org:read'),
    controller.list,
  );
  router.get('/:eventId', event, requireOrgPermission('org:read'), controller.get);
  router.patch(
    '/:eventId',
    event,
    requireOrgPermission('event:update'),
    validate({ body: updateEventSchema }),
    controller.update,
  );
  router.post(
    '/:eventId/publish',
    event,
    requireOrgPermission('event:publish'),
    controller.publish,
  );
  router.post('/:eventId/close', event, requireOrgPermission('event:publish'), controller.close);

  router.post(
    '/:eventId/tiers',
    event,
    requireOrgPermission('event:update'),
    validate({ body: createTierSchema }),
    controller.createTier,
  );
  router.patch(
    '/:eventId/tiers/:tierId',
    tier,
    requireOrgPermission('event:update'),
    validate({ body: updateTierSchema }),
    controller.updateTier,
  );
  router.delete(
    '/:eventId/tiers/:tierId',
    tier,
    requireOrgPermission('event:update'),
    controller.deleteTier,
  );
  return router;
}

/** Mounted at /api/v1/events. No login needed; only published events are ever returned. */
export function publicEventRoutes(): Router {
  const router = Router();
  router.get('/', validate({ query: publicEventsQuerySchema }), controller.listPublic);
  router.get('/:slug', validate({ params: eventSlugParamsSchema }), controller.getPublic);
  return router;
}
