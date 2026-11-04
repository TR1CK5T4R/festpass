import type { AuthResponse } from '@festpass/shared';
import type { Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.js';
import * as auth from './service.js';

// The refresh token lives only in this cookie. httpOnly: page scripts (and XSS) can't read it.
// SameSite=Lax: other sites can't make the browser send it with a POST. Path: it is only sent to
// /api/v1/auth, never to the rest of the API.
export const REFRESH_COOKIE = 'fp_refresh';
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/v1/auth',
} as const;

function readRefreshCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return value.join('=');
  }
  return undefined;
}

function sendSession(res: Response, status: number, session: auth.Session) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...cookieOptions,
    expires: session.refreshExpiresAt,
  });
  const body: AuthResponse = { user: session.user, accessToken: session.accessToken };
  res.status(status).json(body);
}

export const register: RequestHandler = async (req, res) => {
  sendSession(res, 201, await auth.register(req.body));
};

export const login: RequestHandler = async (req, res) => {
  sendSession(res, 200, await auth.login(req.body));
};

export const refresh: RequestHandler = async (req, res) => {
  try {
    sendSession(res, 200, await auth.refresh(readRefreshCookie(req)));
  } catch (err) {
    // A rejected refresh token is useless to the browser, so stop it from sending it again.
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw err;
  }
};

export const logout: RequestHandler = async (req, res) => {
  await auth.logout(readRefreshCookie(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
};

export const me: RequestHandler = async (req, res) => {
  res.json({ user: await auth.me(req.user!.id) });
};
