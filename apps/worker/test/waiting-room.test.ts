import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { JOBS, redisKeys } from '@festpass/shared';
import { isValidAdmission, joinWaitingRoom, waitingRoomPlace } from '@festpass/shared/server';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admitWaitingRooms, processJob } from '../src/processors.js';

const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const SECRET = 'worker-test-admission-secret-0123456789';
const deps = { redis, log: pino({ level: 'silent' }), admissionSecret: SECRET };

let n = 0;
async function makeEvent(data: Record<string, unknown> = {}) {
  n += 1;
  const org = await prisma.organization.create({ data: { name: 'Club', slug: `club-${n}-${randomUUID()}` } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Fest',
      slug: `fest-${randomUUID()}`,
      description: '',
      venue: 'Hall',
      startsAt: new Date(Date.now() + 48 * 3600_000),
      endsAt: new Date(Date.now() + 50 * 3600_000),
      saleStartsAt: new Date(Date.now() - 3600_000),
      saleEndsAt: new Date(Date.now() + 24 * 3600_000),
      status: 'PUBLISHED',
      queueMode: true,
      admitRatePerSec: 2,
      ...data,
    },
  });
  return event.id;
}

async function line(eventId: string, count: number) {
  const users = Array.from({ length: count }, () => randomUUID());
  for (const userId of users) await joinWaitingRoom(redis, eventId, userId);
  return users;
}

beforeEach(async () => {
  await truncateAll(prisma);
  if (redis.options.db !== 15) throw new Error('tests must use redis database 15');
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('admit-waiting-rooms', () => {
  it('admits admitRatePerSec users per tick, oldest first, each with a valid token', async () => {
    const eventId = await makeEvent();
    const users = await line(eventId, 5);

    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 2 });

    for (const userId of users.slice(0, 2)) {
      const place = await waitingRoomPlace(redis, eventId, userId);
      if (!place || !('token' in place)) throw new Error(`${userId} was not admitted`);
      expect(isValidAdmission(place.token, userId, eventId, SECRET)).toBe(true);
    }
    expect(await redis.zrange(redisKeys.waitingRoom(eventId), '0', '-1')).toEqual(users.slice(2));
  });

  it('goes through the whole line in order, then stops being active', async () => {
    const eventId = await makeEvent({ admitRatePerSec: 1 });
    const users = await line(eventId, 3);

    for (let tick = 0; tick < users.length; tick++) {
      await admitWaitingRooms(deps);
      expect(await redis.zrange(redisKeys.waitingRoom(eventId), '0', '-1')).toEqual(
        users.slice(tick + 1),
      );
    }

    expect(await redis.smembers(redisKeys.activeWaitingRooms)).toEqual([]);
    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 0 });
  });

  it('uses a new admit rate on the next tick', async () => {
    const eventId = await makeEvent({ admitRatePerSec: 1 });
    await line(eventId, 5);
    await admitWaitingRooms(deps);
    await prisma.event.update({ where: { id: eventId }, data: { admitRatePerSec: 3 } });

    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 3 });
  });

  it('serves each event at its own rate', async () => {
    const slow = await makeEvent({ admitRatePerSec: 1 });
    const fast = await makeEvent({ admitRatePerSec: 3 });
    await line(slow, 4);
    await line(fast, 4);

    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 4 });
    expect(await redis.zcard(redisKeys.waitingRoom(slow))).toBe(3);
    expect(await redis.zcard(redisKeys.waitingRoom(fast))).toBe(1);
  });

  it.each([
    ['queue mode is turned off', { queueMode: false }],
    ['the event is closed', { status: 'CLOSED' as const }],
    ['the sale has ended', { saleEndsAt: new Date(Date.now() - 1000) }],
  ])('deletes the line when %s, issuing no tokens', async (_name, change) => {
    const eventId = await makeEvent();
    const [userId] = await line(eventId, 2);
    await prisma.event.update({ where: { id: eventId }, data: change });

    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 0 });
    expect(await redis.exists(redisKeys.waitingRoom(eventId))).toBe(0);
    expect(await redis.smembers(redisKeys.activeWaitingRooms)).toEqual([]);
    expect(await waitingRoomPlace(redis, eventId, userId!)).toBeNull();
  });

  it('keeps the line, admitting nobody, when the sale moves later', async () => {
    const eventId = await makeEvent();
    await line(eventId, 2);
    await prisma.event.update({
      where: { id: eventId },
      data: { saleStartsAt: new Date(Date.now() + 3600_000) },
    });

    expect(await admitWaitingRooms(deps)).toEqual({ admitted: 0 });
    expect(await redis.zcard(redisKeys.waitingRoom(eventId))).toBe(2);
  });

  it('is routed by job name', async () => {
    const eventId = await makeEvent();
    await line(eventId, 1);

    const result = await processJob(
      { id: '1', name: JOBS.admitWaitingRooms, data: {}, attemptsMade: 0 } as Job,
      deps,
    );

    expect(result).toEqual({ admitted: 1 });
  });
});
