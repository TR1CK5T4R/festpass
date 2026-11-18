import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router } from 'express';
import { inventoryQueue, ordersQueue, paymentsQueue, ticketsQueue } from '../../lib/queues.js';
import { requireAuth } from '../../middleware/require-auth.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/admin. */
export function adminApiRoutes(): Router {
  const router = Router();
  router.post('/session', requireAuth, controller.startSession);
  return router;
}

/** Bull Board, mounted at /admin/queues behind the admin cookie: watch, retry and clean jobs. */
export function queueDashboard(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [ordersQueue, paymentsQueue, ticketsQueue, inventoryQueue].map(
      (q) => new BullMQAdapter(q),
    ),
    serverAdapter,
  });
  const router = Router();
  router.use(controller.requireAdminSession, serverAdapter.getRouter());
  return router;
}
