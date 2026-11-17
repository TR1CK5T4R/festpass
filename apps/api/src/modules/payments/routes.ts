import { orderIdParamsSchema } from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/** Mounted at /api/v1/orders. */
export function paymentRoutes(): Router {
  const router = Router();
  router.post(
    '/:orderId/pay',
    requireAuth,
    validate({ params: orderIdParamsSchema }),
    controller.pay,
  );
  return router;
}
