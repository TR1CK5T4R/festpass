import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { readCookie } from '../../lib/cookies.js';
import * as admin from './service.js';

/**
 * Bull Board is a browser page, and browsers don't send our Bearer token on a page load, so a logged-in
 * admin first trades the token for a 15-minute httpOnly cookie that only /admin paths receive.
 */
export const startSession: RequestHandler = async (req, res) => {
  const token = await admin.startAdminSession(req.user!.id);
  res.cookie(admin.ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // Lax, not Strict: the cookie must be sent when the dashboard opens /admin/queues as a top-level
    // navigation, which in production may come from the web app's own domain.
    sameSite: 'lax',
    path: '/admin',
    maxAge: admin.ADMIN_SESSION_SECONDS * 1000,
  });
  res.status(204).end();
};

export const requireAdminSession: RequestHandler = async (req, _res, next) => {
  await admin.verifyAdminSession(readCookie(req, admin.ADMIN_COOKIE));
  next();
};
