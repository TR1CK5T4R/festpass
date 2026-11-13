import { prisma } from '@festpass/db';
import type { OrgRole } from '@festpass/shared';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';

export const app = createApp();

export type TestUser = Awaited<ReturnType<typeof makeUser>>;

// Users are inserted directly (no bcrypt) and get a signed access token, so tests stay fast.
let n = 0;
export async function makeUser(name = 'User') {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `user${n}-${Date.now()}@test.dev`, name, passwordHash: 'x' },
  });
  const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET!, {
    subject: user.id,
    algorithm: 'HS256',
  });
  return { id: user.id, email: user.email, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeOrg(owner: TestUser, name = 'Coding Club') {
  const res = await request(app).post('/api/v1/orgs').set(owner.auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.org.id as string;
}

export async function addMember(orgId: string, userId: string, role: OrgRole) {
  await prisma.orgMember.create({ data: { orgId, userId, role } });
}

/** Many users in one insert, for concurrency tests (200 separate inserts would dominate the run time). */
export async function makeUsers(count: number): Promise<TestUser[]> {
  const stamp = Date.now();
  const users = await prisma.user.createManyAndReturn({
    data: Array.from({ length: count }, (_, i) => ({
      email: `crowd${i}-${stamp}@test.dev`,
      name: `Buyer ${i}`,
      passwordHash: 'x',
    })),
  });
  return users.map((user) => {
    const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET!, {
      subject: user.id,
      algorithm: 'HS256',
    });
    return { id: user.id, email: user.email, auth: { Authorization: `Bearer ${token}` } };
  });
}
