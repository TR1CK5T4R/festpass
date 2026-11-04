import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LoginInput, PublicUser, RegisterInput } from '@festpass/shared';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repository.js';

// Cost 12: about 250 ms per hash on a laptop. Slow enough to make offline guessing expensive,
// fast enough for a login form.
const BCRYPT_COST = 12;
// A real bcrypt hash of a random string. Login compares against it when the email doesn't exist,
// so "unknown email" takes as long as "wrong password" and timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), BCRYPT_COST);

const INVALID_CREDENTIALS = new UnauthorizedError(
  'Invalid email or password',
  'INVALID_CREDENTIALS',
);

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

// Fields are picked one by one (no spread), so a hash or any column added later can't slip into a response.
function toPublicUser(user: repo.UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Only the SHA-256 of a refresh token is stored: a leaked database dump can't be replayed as sessions. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns the user ID, or throws 401. Pinning the algorithm stops "alg: none" and algorithm-swap tricks. */
export function verifyAccessToken(token: string): string {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) throw new Error('missing subject');
    return payload.sub;
  } catch {
    throw new UnauthorizedError('Invalid or expired access token', 'INVALID_ACCESS_TOKEN');
  }
}

/** 256 random bits for the browser, plus the hash and expiry that go into the database. */
function newRefreshToken() {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashRefreshToken(token), expiresAt };
}

/** A login starts a new token family; every refresh in this session stays in the same family. */
async function startSession(user: repo.UserRecord): Promise<Session> {
  const refresh = newRefreshToken();
  await repo.createRefreshToken({
    userId: user.id,
    tokenHash: refresh.tokenHash,
    familyId: randomUUID(),
    expiresAt: refresh.expiresAt,
  });
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(user.id),
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

export async function register(input: RegisterInput): Promise<Session> {
  const { password, ...profile } = input;
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await repo.createUser({ ...profile, passwordHash });
  if (!user) throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
  return startSession(user);
}

export async function login({ email, password }: LoginInput): Promise<Session> {
  const user = await repo.findUserForLogin(email);
  const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  // Same error for "no such email" and "wrong password", so the response can't be used to find accounts.
  if (!user || !matches) throw INVALID_CREDENTIALS;
  return startSession(user);
}

/**
 * Rotation with reuse detection. Every refresh revokes the presented token and issues a new one.
 * A revoked token should never be seen again: if it is, someone kept a copy (a stolen token or a
 * replayed request), so the whole family is revoked and both the attacker and the user must log in again.
 */
export async function refresh(token: string | undefined): Promise<Session> {
  if (!token) throw new UnauthorizedError('Refresh token missing', 'INVALID_REFRESH_TOKEN');
  const stored = await repo.findRefreshToken(hashRefreshToken(token));
  if (!stored || stored.expiresAt <= new Date()) {
    throw new UnauthorizedError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  const reuse = async () => {
    const revoked = await repo.revokeFamily(stored.familyId);
    // Log who and which family, never the token itself.
    logger.warn(
      { userId: stored.userId, familyId: stored.familyId, revoked },
      'refresh token reuse detected; family revoked',
    );
    return new UnauthorizedError(
      'Refresh token reuse detected; please log in again',
      'REFRESH_TOKEN_REUSED',
    );
  };
  if (stored.revokedAt) throw await reuse();

  const user = await repo.findUserById(stored.userId);
  if (!user)
    throw new UnauthorizedError('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

  const next = newRefreshToken();
  const rotated = await repo.rotateRefreshToken(stored.id, {
    userId: stored.userId,
    tokenHash: next.tokenHash,
    familyId: stored.familyId,
    expiresAt: next.expiresAt,
  });
  // Lost the race against another refresh with the same token: that is reuse too.
  if (!rotated) throw await reuse();

  return {
    user: toPublicUser(user),
    accessToken: signAccessToken(user.id),
    refreshToken: next.token,
    refreshExpiresAt: next.expiresAt,
  };
}

/** Ends this session (the token's whole family). Idempotent: an unknown or missing token is fine. */
export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  const stored = await repo.findRefreshToken(hashRefreshToken(token));
  if (stored) await repo.revokeFamily(stored.familyId);
}

export async function me(userId: string): Promise<PublicUser> {
  const user = await repo.findUserById(userId);
  // The token is valid but the account is gone: treat it like a bad token.
  if (!user) throw new UnauthorizedError();
  return toPublicUser(user);
}
