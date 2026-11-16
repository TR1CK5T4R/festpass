import { loginSchema, registerSchema } from '@festpass/shared';
import { Router } from 'express';
import type { RateLimits } from '../../app.js';
import { byIp, byIpAndEmail, rateLimit } from '../../lib/rate-limit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

// The limiter runs before validation, so malformed spam costs a token too.
export function authRoutes(limits: Pick<RateLimits, 'login' | 'register'>): Router {
  const router = Router();
  router.post(
    '/register',
    rateLimit({ name: 'register', keyFn: byIp, ...limits.register }),
    validate({ body: registerSchema }),
    controller.register,
  );
  router.post(
    '/login',
    rateLimit({ name: 'login', keyFn: byIpAndEmail, ...limits.login }),
    validate({ body: loginSchema }),
    controller.login,
  );
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth, controller.me);
  return router;
}
