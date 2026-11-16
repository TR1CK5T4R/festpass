import { presignUploadSchema } from '@festpass/shared';
import { Router } from 'express';
import { byUser, rateLimit, type Limit } from '../../lib/rate-limit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

/**
 * Mounted at /api/v1/uploads. The API only signs uploads; the file goes from the browser straight to
 * storage. The org comes from the event in the body, so the permission check happens in the service.
 */
export function uploadRoutes(limit: Limit): Router {
  const router = Router();
  router.use(requireAuth);
  router.post(
    '/presign',
    rateLimit({ name: 'presign', keyFn: byUser, ...limit }),
    validate({ body: presignUploadSchema }),
    controller.presign,
  );
  return router;
}
