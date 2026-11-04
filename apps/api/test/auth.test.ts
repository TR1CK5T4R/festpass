import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashRefreshToken } from '../src/modules/auth/service.js';

const app = createApp();
const asha = { email: 'Asha@MAIT.ac.in', password: 'correct-horse-9', name: 'Asha Verma' };

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

/** The fp_refresh cookie from a response: its value and its full Set-Cookie line. */
function refreshCookie(res: request.Response) {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = header.find((c) => c.startsWith('fp_refresh='));
  return { line, value: line?.split(';')[0]?.slice('fp_refresh='.length) };
}

const register = (body: object = asha) => request(app).post('/api/v1/auth/register').send(body);
const login = (body: object) => request(app).post('/api/v1/auth/login').send(body);
const refresh = (token: string) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', `fp_refresh=${token}`);
const me = (accessToken?: string) => {
  const req = request(app).get('/api/v1/auth/me');
  return accessToken ? req.set('Authorization', `Bearer ${accessToken}`) : req;
};

describe('register', () => {
  it('creates the user, returns an access token and sets a locked-down refresh cookie', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'asha@mait.ac.in', name: 'Asha Verma' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.accessToken).toEqual(expect.any(String));

    const cookie = refreshCookie(res);
    expect(cookie.line).toMatch(/HttpOnly/);
    expect(cookie.line).toMatch(/SameSite=Lax/);
    expect(cookie.line).toMatch(/Path=\/api\/v1\/auth/);

    // The database holds a bcrypt hash (cost 12) and only the SHA-256 of the refresh token.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'asha@mait.ac.in' } });
    expect(user.passwordHash).toMatch(/^\$2b\$12\$/);
    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toBe(hashRefreshToken(cookie.value!));
    expect(tokens[0]!.tokenHash).not.toBe(cookie.value);
  });

  it('rejects a duplicate email, whatever its case', async () => {
    await register();
    const res = await register({ ...asha, email: 'asha@mait.ac.in' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a short password with field details', async () => {
    const res = await register({ ...asha, password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toEqual([
      expect.objectContaining({ location: 'body', path: 'password' }),
    ]);
  });
});

describe('login and /me', () => {
  it('logs in with the right password and /me returns the user', async () => {
    await register();
    const res = await login({ email: 'asha@mait.ac.in', password: asha.password });

    expect(res.status).toBe(200);
    expect(refreshCookie(res).value).toBeTruthy();

    const profile = await me(res.body.accessToken);
    expect(profile.status).toBe(200);
    expect(profile.body.user).toMatchObject({ email: 'asha@mait.ac.in' });
    expect(profile.body.user).not.toHaveProperty('passwordHash');
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    await register();
    const wrongPassword = await login({ email: asha.email, password: 'not-the-password' });
    const unknownEmail = await login({ email: 'nobody@mait.ac.in', password: asha.password });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
  });

  it('/me without a token returns 401', async () => {
    const res = await me();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('/me rejects an expired or forged token', async () => {
    const { body } = await register();
    const { sub } = jwt.decode(body.accessToken) as { sub: string };
    const expired = jwt.sign(
      { sub, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_ACCESS_SECRET!,
    );
    const forged = jwt.sign({ sub }, 'some-other-secret-that-is-long-enough!!');

    for (const token of [expired, forged]) {
      const res = await me(token);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_ACCESS_TOKEN');
    }
  });
});

describe('refresh rotation', () => {
  it('issues a new refresh token and revokes the old one', async () => {
    const first = refreshCookie(await register()).value!;

    const res = await refresh(first);

    expect(res.status).toBe(200);
    const second = refreshCookie(res).value!;
    expect(second).not.toBe(first);
    expect((await me(res.body.accessToken)).status).toBe(200);

    const old = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(first) },
    });
    const next = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(second) },
    });
    expect(old.revokedAt).not.toBeNull();
    expect(next.revokedAt).toBeNull();
    expect(next.familyId).toBe(old.familyId);
  });

  it('reusing an old token revokes the whole family, including the newest token', async () => {
    const stolen = refreshCookie(await register()).value!;
    const current = refreshCookie(await refresh(stolen)).value!; // the real user rotates

    const replay = await refresh(stolen); // the attacker replays the stolen copy

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    const afterReuse = await refresh(current);
    expect(afterReuse.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('rejects a missing or unknown refresh token', async () => {
    const missing = await request(app).post('/api/v1/auth/refresh');
    const unknown = await refresh('not-a-real-token');

    for (const res of [missing, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    }
  });
});

describe('logout', () => {
  it('revokes the session and clears the cookie, so the refresh token stops working', async () => {
    const token = refreshCookie(await register()).value!;

    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', `fp_refresh=${token}`);

    expect(res.status).toBe(204);
    expect(refreshCookie(res).line).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await refresh(token)).status).toBe(401);
  });
});
