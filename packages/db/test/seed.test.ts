import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';
import bcrypt from 'bcrypt';
import { SEED_PASSWORD, seed } from '../src/seed.js';
import { truncateAll } from '../src/testing.js';

const countAll = async () => ({
  users: await prisma.user.count(),
  orgs: await prisma.organization.count(),
  members: await prisma.orgMember.count(),
  events: await prisma.event.count(),
  tiers: await prisma.ticketTier.count(),
  sponsors: await prisma.sponsor.count(),
  sponsorMembers: await prisma.sponsorMember.count(),
  booths: await prisma.booth.count(),
});

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

describe('seed', () => {
  it('creates the demo data and does not duplicate it when run twice', async () => {
    const expected = {
      users: 4,
      orgs: 1,
      members: 2,
      events: 1,
      tiers: 3,
      sponsors: 1,
      sponsorMembers: 1,
      booths: 1,
    };

    await seed(prisma);
    expect(await countAll()).toEqual(expected);
    await seed(prisma);
    expect(await countAll()).toEqual(expected);

    const event = await prisma.event.findUniqueOrThrow({
      where: { slug: 'mait-alumni-meet-2026' },
      include: {
        tiers: { orderBy: { pricePaise: 'asc' } },
        sponsors: { include: { booths: true } },
      },
    });
    expect(event.status).toBe('PUBLISHED');
    expect(event.tiers.map((t) => t.name)).toEqual(['Early bird', 'Regular', 'VIP']);
    expect(event.sponsors[0]?.booths).toHaveLength(1);
  });
});

describe('truncateAll', () => {
  it('refuses to run against a database that is not *_test', async () => {
    const fake = { $queryRaw: async () => [{ name: 'festpass' }] } as unknown as typeof prisma;

    await expect(truncateAll(fake)).rejects.toThrow(/refusing to truncate "festpass"/);
  });
});

describe('seed users', () => {
  it('can log in with the documented demo password', async () => {
    await seed(prisma);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'organizer@festpass.dev' },
    });

    expect(await bcrypt.compare(SEED_PASSWORD, user.passwordHash)).toBe(true);
  });
});
