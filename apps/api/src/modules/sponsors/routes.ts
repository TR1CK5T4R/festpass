import {
  addSponsorMemberSchema,
  boothParamsSchema,
  boothScanSchema,
  createBoothSchema,
  createSponsorSchema,
  eventIdParamsSchema,
  eventParamsSchema,
  sponsorIdParamsSchema,
  sponsorMemberParamsSchema,
  sponsorParamsSchema,
} from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireEventPermission } from '../../middleware/require-event-permission.js';
import { requireOrgPermission } from '../../middleware/require-org-permission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/orgs/:orgId/events/:eventId/sponsors: the organizer sets up sponsors. */
export function orgSponsorRoutes(): Router {
  const router = Router({ mergeParams: true });
  const sponsor = validate({ params: sponsorParamsSchema });
  router.use(requireAuth, validate({ params: eventParamsSchema }));
  router.use(requireOrgPermission('event:update'));
  router.get('/', controller.list);
  router.post('/', validate({ body: createSponsorSchema }), controller.create);
  router.post(
    '/:sponsorId/booths',
    sponsor,
    validate({ body: createBoothSchema }),
    controller.createBooth,
  );
  router.post(
    '/:sponsorId/members',
    sponsor,
    validate({ body: addSponsorMemberSchema }),
    controller.addMember,
  );
  router.delete(
    '/:sponsorId/members/:userId',
    validate({ params: sponsorMemberParamsSchema }),
    controller.removeMember,
  );
  return router;
}

/** Mounted at /api/v1/events/:eventId/booths: what a scanner can open at this event. */
export function eventBoothRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.get(
    '/',
    requireAuth,
    validate({ params: eventIdParamsSchema }),
    requireEventPermission('checkin:scan'),
    controller.booths,
  );
  return router;
}

/** Mounted at /api/v1/booths. The permission check needs the booth's event, so it is in the service. */
export function boothRoutes(): Router {
  const router = Router();
  router.post(
    '/:boothId/scans',
    requireAuth,
    validate({ params: boothParamsSchema, body: boothScanSchema }),
    controller.boothScan,
  );
  return router;
}

/** Mounted at /api/v1/sponsors: the sponsor portal, for the sponsor's own users. */
export function sponsorPortalRoutes(): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/mine', controller.mine);
  router.get(
    '/:sponsorId/analytics',
    validate({ params: sponsorIdParamsSchema }),
    controller.analytics,
  );
  return router;
}
