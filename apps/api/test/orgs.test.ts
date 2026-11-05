import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { ORG_ACTIONS, ORG_ROLES, can, type OrgAction, type OrgRole } from '@festpass/shared';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requireAuth } from '../src/middleware/require-auth.js';
import { requireOrgPermission } from '../src/middleware/require-org-permission.js';
import { changeMembership } from '../src/modules/orgs/repository.js';

const app = createApp();

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

// Users are inserted directly (no bcrypt) and get a signed access token, so tests stay fast.
let n = 0;
async function makeUser(name = 'User') {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `user${n}@test.dev`, name, passwordHash: 'x' },
  });
  const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET!, {
    subject: user.id,
    algorithm: 'HS256',
  });
  return { id: user.id, email: user.email, auth: { Authorization: `Bearer ${token}` } };
}

async function makeOrg(owner: Awaited<ReturnType<typeof makeUser>>, name = 'Coding Club') {
  const res = await request(app).post('/api/v1/orgs').set(owner.auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.org.id as string;
}

async function addMember(orgId: string, userId: string, role: OrgRole) {
  await prisma.orgMember.create({ data: { orgId, userId, role } });
}

// The policy, written out by hand. If someone edits PERMISSIONS, this test makes them change it on purpose.
const EXPECTED: Record<OrgRole, Record<OrgAction, boolean>> = {
  OWNER: {
    'org:read': true,
    'member:manage': true,
    'event:create': true,
    'event:update': true,
    'event:publish': true,
    'checkin:scan': true,
  },
  MANAGER: {
    'org:read': true,
    'member:manage': false,
    'event:create': true,
    'event:update': true,
    'event:publish': true,
    'checkin:scan': true,
  },
  SCANNER: {
    'org:read': true,
    'member:manage': false,
    'event:create': false,
    'event:update': false,
    'event:publish': false,
    'checkin:scan': true,
  },
};

const grid = ORG_ROLES.flatMap((role) => ORG_ACTIONS.map((action) => [role, action] as const));

describe('permission matrix', () => {
  it.each(grid)('can(%s, %s) matches the policy', (role, action) => {
    expect(can(role, action)).toBe(EXPECTED[role][action]);
  });

  // One probe route per action, guarded by the real middleware, so the matrix is tested end to end.
  const probe = express();
  for (const action of ORG_ACTIONS) {
    probe.get(`/probe/${action}/:orgId`, requireAuth, requireOrgPermission(action), (_req, res) => {
      res.json({ ok: true });
    });
  }
  probe.use(errorHandler);

  it('requireOrgPermission allows or denies every role × action as the policy says', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const members: Record<OrgRole, Awaited<ReturnType<typeof makeUser>>> = {
      OWNER: owner,
      MANAGER: await makeUser(),
      SCANNER: await makeUser(),
    };
    await addMember(orgId, members.MANAGER.id, 'MANAGER');
    await addMember(orgId, members.SCANNER.id, 'SCANNER');

    for (const [role, action] of grid) {
      const res = await request(probe).get(`/probe/${action}/${orgId}`).set(members[role].auth);
      expect(res.status, `${role} ${action}`).toBe(EXPECTED[role][action] ? 200 : 403);
    }
  });

  it('a non-member gets 404 for every action', async () => {
    const orgId = await makeOrg(await makeUser());
    const outsider = await makeUser();

    for (const action of ORG_ACTIONS) {
      const res = await request(probe).get(`/probe/${action}/${orgId}`).set(outsider.auth);
      expect(res.status, action).toBe(404);
    }
  });
});

describe('creating and listing orgs', () => {
  it('makes the creator OWNER and derives the slug from the name', async () => {
    const owner = await makeUser();
    const res = await request(app)
      .post('/api/v1/orgs')
      .set(owner.auth)
      .send({ name: 'MAIT Coding Club!' });

    expect(res.status).toBe(201);
    expect(res.body.org).toMatchObject({ slug: 'mait-coding-club', role: 'OWNER' });

    const mine = await request(app).get('/api/v1/orgs/mine').set(owner.auth);
    expect(mine.body.orgs).toEqual([res.body.org]);
  });

  it('rejects a slug that is already taken', async () => {
    const owner = await makeUser();
    await makeOrg(owner, 'Coding Club');
    const res = await request(app)
      .post('/api/v1/orgs')
      .set(owner.auth)
      .send({ name: 'Coding Club' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_TAKEN');
  });

  it('requires login', async () => {
    expect((await request(app).get('/api/v1/orgs/mine')).status).toBe(401);
  });
});

describe('org visibility', () => {
  it('a non-member gets the same 404 as for an org that does not exist', async () => {
    const orgId = await makeOrg(await makeUser());
    const outsider = await makeUser();

    const real = await request(app).get(`/api/v1/orgs/${orgId}`).set(outsider.auth);
    const fake = await request(app)
      .get('/api/v1/orgs/00000000-0000-4000-8000-000000000000')
      .set(outsider.auth);

    expect(real.status).toBe(404);
    expect(fake.status).toBe(404);
    expect({ ...real.body.error, requestId: '' }).toEqual({ ...fake.body.error, requestId: '' });
  });

  it('a member sees the org, their role and the member list', async () => {
    const owner = await makeUser('Olivia');
    const orgId = await makeOrg(owner);
    const scanner = await makeUser('Sam');
    await addMember(orgId, scanner.id, 'SCANNER');

    const res = await request(app).get(`/api/v1/orgs/${orgId}`).set(scanner.auth);

    expect(res.status).toBe(200);
    expect(res.body.org.role).toBe('SCANNER');
    expect(res.body.members.map((m: { name: string; role: string }) => [m.name, m.role])).toEqual([
      ['Olivia', 'OWNER'],
      ['Sam', 'SCANNER'],
    ]);
  });
});

describe('managing members', () => {
  it('an owner adds an existing user by email; adding them twice is a conflict', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const asha = await makeUser();
    const add = () =>
      request(app)
        .post(`/api/v1/orgs/${orgId}/members`)
        .set(owner.auth)
        .send({ email: asha.email.toUpperCase(), role: 'MANAGER' });

    const first = await add();
    expect(first.status).toBe(201);
    expect(first.body.member).toEqual({ userId: asha.id, role: 'MANAGER' });
    expect((await request(app).get(`/api/v1/orgs/${orgId}`).set(asha.auth)).status).toBe(200);

    const second = await add();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('adding an email with no account returns 404', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/members`)
      .set(owner.auth)
      .send({ email: 'nobody@test.dev', role: 'SCANNER' });

    expect(res.status).toBe(404);
  });

  it('a manager cannot manage members (403)', async () => {
    const orgId = await makeOrg(await makeUser());
    const manager = await makeUser();
    await addMember(orgId, manager.id, 'MANAGER');
    const other = await makeUser();

    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/members`)
      .set(manager.auth)
      .send({ email: other.email, role: 'SCANNER' });

    expect(res.status).toBe(403);
  });

  it('removing a member takes away their access', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const scanner = await makeUser();
    await addMember(orgId, scanner.id, 'SCANNER');

    const res = await request(app)
      .delete(`/api/v1/orgs/${orgId}/members/${scanner.id}`)
      .set(owner.auth);

    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/v1/orgs/${orgId}`).set(scanner.auth)).status).toBe(404);
  });
});

describe('the last OWNER', () => {
  it('cannot be demoted or removed', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const member = `/api/v1/orgs/${orgId}/members/${owner.id}`;

    const demote = await request(app).patch(member).set(owner.auth).send({ role: 'MANAGER' });
    const remove = await request(app).delete(member).set(owner.auth);

    for (const res of [demote, remove]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_OWNER');
    }
    expect(await prisma.orgMember.count({ where: { orgId, role: 'OWNER' } })).toBe(1);
  });

  it('can step down once there is a second owner', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const second = await makeUser();
    await addMember(orgId, second.id, 'OWNER');

    const res = await request(app)
      .patch(`/api/v1/orgs/${orgId}/members/${owner.id}`)
      .set(owner.auth)
      .send({ role: 'MANAGER' });

    expect(res.status).toBe(200);
    expect(res.body.member).toEqual({ userId: owner.id, role: 'MANAGER' });
  });

  // Called below the HTTP layer: over HTTP the second request is usually refused earlier (403, it is
  // no longer an owner), which would hide whether the row lock works.
  it('survives two owners demoting each other at the same moment', async () => {
    const a = await makeUser();
    const orgId = await makeOrg(a);
    const b = await makeUser();
    await addMember(orgId, b.id, 'OWNER');

    const results = await Promise.all([
      changeMembership(orgId, b.id, 'MANAGER'),
      changeMembership(orgId, a.id, 'MANAGER'),
    ]);

    expect(results.sort()).toEqual(['LAST_OWNER', 'OK']);
    expect(await prisma.orgMember.count({ where: { orgId, role: 'OWNER' } })).toBe(1);
  });
});
