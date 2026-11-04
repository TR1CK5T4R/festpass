import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Only the ID: anything else is loaded fresh, so it is never stale. */
      user?: { id: string };
    }
  }
}

/** Verifies `Authorization: Bearer <access token>` and sets req.user, or responds 401. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) return next(new UnauthorizedError());
  req.user = { id: verifyAccessToken(token) };
  next();
};
