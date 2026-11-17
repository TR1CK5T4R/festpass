import { randomUUID } from 'node:crypto';
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

export interface SaleTier {
  name: string;
  capacity: number;
  perUserLimit?: number;
  pricePaise?: number;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** A published event of `orgId` whose sale opened an hour ago, with the given tiers (₹299 by default). */
export async function createSaleEvent(owner: TestUser, orgId: string, tiers: SaleTier[]) {
  const created = await request(app)
    .post(`/api/v1/orgs/${orgId}/events`)
    .set(owner.auth)
    .send({
      title: `Fest ${randomUUID().slice(0, 6)}`,
      venue: 'MAIT Auditorium',
      startsAt: inHours(48),
      endsAt: inHours(52),
      saleStartsAt: inHours(-1),
      saleEndsAt: inHours(24),
    });
  const eventId = created.body.event.id as string;
  const tierIds: string[] = [];
  for (const t of tiers) {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/events/${eventId}/tiers`)
      .set(owner.auth)
      .send({ pricePaise: 29_900, perUserLimit: 4, ...t });
    tierIds.push(res.body.tier.id);
  }
  await request(app).post(`/api/v1/orgs/${orgId}/events/${eventId}/publish`).set(owner.auth);
  return { eventId, tierIds };
}

/** POST /events/:eventId/orders with a fresh (or given) Idempotency-Key. */
export const book = (
  user: TestUser,
  eventId: string,
  items: { tierId: string; qty: number }[],
  key: string = randomUUID(),
) =>
  request(app)
    .post(`/api/v1/events/${eventId}/orders`)
    .set(user.auth)
    .set('Idempotency-Key', key)
    .send({ items });
