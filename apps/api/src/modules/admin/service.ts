import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { findUserById } from '../auth/repository.js';

export const ADMIN_COOKIE = 'fp_admin';
export const ADMIN_SESSION_SECONDS = 15 * 60;

// Signed with a key derived from the access-token secret, not the secret itself, so an admin cookie
// can never be replayed as a Bearer access token (and the other way round).
const adminKey = createHmac('sha256', env.JWT_ACCESS_SECRET)
  .update('festpass-admin-cookie')
  .digest();

const isAdminEmail = (email: string) => env.ADMIN_EMAILS.includes(email.toLowerCase());

async function assertAdmin(userId: string) {
  const user = await findUserById(userId);
  if (!user || !isAdminEmail(user.email)) {
    throw new ForbiddenError('Only admins listed in ADMIN_EMAILS can open the job dashboard');
  }
}

/** For a logged-in admin: a short-lived token for the admin cookie. */
export async function startAdminSession(userId: string): Promise<string> {
  await assertAdmin(userId);
  return jwt.sign({}, adminKey, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: ADMIN_SESSION_SECONDS,
  });
}

/**
 * Checks the admin cookie on every request to the dashboard. The email is checked again each time,
 * so removing someone from ADMIN_EMAILS (and restarting) locks them out at once.
 */
export async function verifyAdminSession(token: string | undefined): Promise<void> {
  let userId: string;
  try {
    userId = String(jwt.verify(token ?? '', adminKey, { algorithms: ['HS256'] }).sub);
  } catch {
    throw new UnauthorizedError(
      'Open the job dashboard from the FestPass dashboard (/dashboard/queues)',
    );
  }
  await assertAdmin(userId);
}
