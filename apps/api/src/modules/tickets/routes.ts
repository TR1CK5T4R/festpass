import { ticketIdParamsSchema } from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/me/tickets: the logged-in user's tickets. */
export function myTicketRoutes(): Router {
  const router = Router();
  router.get('/', requireAuth, controller.listMine);
  return router;
}

/** Mounted at /api/v1/tickets: one ticket, owner only. */
export function ticketRoutes(): Router {
  const router = Router();
  const params = validate({ params: ticketIdParamsSchema });
  router.get('/:ticketId', requireAuth, params, controller.get);
  router.post('/:ticketId/reissue', requireAuth, params, controller.reissue);
  return router;
}
