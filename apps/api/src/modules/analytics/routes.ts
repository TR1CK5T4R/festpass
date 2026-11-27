import { checkinAnalyticsQuerySchema, eventParamsSchema } from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOrgPermission } from '../../middleware/require-org-permission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/orgs/:orgId/events/:eventId/analytics. Owners and managers only (revenue). */
export function analyticsRoutes(): Router {
  const router = Router({ mergeParams: true });
  router.use(
    requireAuth,
    validate({ params: eventParamsSchema }),
    requireOrgPermission('analytics:read'),
  );
  router.get('/sales', controller.sales);
  router.get('/checkins', validate({ query: checkinAnalyticsQuerySchema }), controller.checkins);
  return router;
}
