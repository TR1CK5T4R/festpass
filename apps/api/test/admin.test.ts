import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, makeUser, type TestUser } from './helpers.js';

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

// vitest.config sets ADMIN_EMAILS=admin@festpass.test
async function makeAdmin(): Promise<TestUser> {
  const user = await makeUser('Admin');
  await prisma.user.update({ where: { id: user.id }, data: { email: 'admin@festpass.test' } });
  return { ...user, email: 'admin@festpass.test' };
}

const adminCookie = async (admin: TestUser) => {
  const res = await request(app).post('/api/v1/admin/session').set(admin.auth);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
};

describe('job dashboard (Bull Board) access', () => {
  it('only ADMIN_EMAILS get the admin cookie, scoped to /admin and httpOnly', async () => {
    const organizer = await makeUser();
    const admin = await makeAdmin();

    const denied = await request(app).post('/api/v1/admin/session').set(organizer.auth);
    const anonymous = await request(app).post('/api/v1/admin/session');
    const granted = await request(app).post('/api/v1/admin/session').set(admin.auth);

    expect(denied.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(granted.status).toBe(204);
    expect(granted.headers['set-cookie']![0]).toMatch(
      /^fp_admin=[^;]+; Max-Age=900; Path=\/admin; Expires=[^;]+; HttpOnly; SameSite=Lax$/,
    );
  });

  it('the board needs the admin cookie, and shows both queues with it', async () => {
    const cookie = await adminCookie(await makeAdmin());

    const without = await request(app).get('/admin/queues');
    const page = await request(app).get('/admin/queues').set('Cookie', cookie);
    const queues = await request(app).get('/admin/queues/api/queues').set('Cookie', cookie);

    expect(without.status).toBe(401);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(queues.body.queues.map((q: { name: string }) => q.name).sort()).toEqual([
      'inventory',
      'orders',
    ]);
  });

  it('an access token is not an admin cookie, and an admin cookie is not an access token', async () => {
    const admin = await makeAdmin();
    const accessToken = admin.auth.Authorization.replace('Bearer ', '');
    const cookie = await adminCookie(admin);

    const tokenAsCookie = await request(app)
      .get('/admin/queues')
      .set('Cookie', `fp_admin=${accessToken}`);
    const cookieAsToken = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${cookie.split('=')[1]}`);

    expect(tokenAsCookie.status).toBe(401);
    expect(cookieAsToken.status).toBe(401);
  });

  it('someone removed from ADMIN_EMAILS loses access even with a valid cookie', async () => {
    const admin = await makeAdmin();
    const cookie = await adminCookie(admin);
    await prisma.user.update({ where: { id: admin.id }, data: { email: 'former-admin@test.dev' } });

    expect((await request(app).get('/admin/queues').set('Cookie', cookie)).status).toBe(403);
  });
});
