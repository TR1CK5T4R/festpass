import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';
import { seed } from '../src/seed.js';

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

afterAll(() => prisma.$disconnect());

describe('seed', () => {
  it('creates the demo data and does not duplicate it when run twice', async () => {
    await seed(prisma);
    const afterFirst = await countAll();
    await seed(prisma);

    expect(await countAll()).toEqual(afterFirst);

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
