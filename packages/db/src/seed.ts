import { pathToFileURL } from 'node:url';
import { prisma, type PrismaClient } from './index.js';

// shortcut: seed users get a hash that matches no password, so they can't log in until Day 4 adds bcrypt here.
const NO_LOGIN_HASH = '!seed-user-no-password';

// Every write is an upsert on a unique key with an empty update, so running the seed again
// never duplicates rows and never resets live data such as sold_count.
export async function seed(db: PrismaClient): Promise<void> {
  const org = await db.organization.upsert({
    where: { slug: 'mait-alumni-cell' },
    update: {},
    create: { name: 'MAIT Alumni Cell', slug: 'mait-alumni-cell' },
  });

  const user = (email: string, name: string) =>
    db.user.upsert({
      where: { email },
      update: {},
      create: { email, name, passwordHash: NO_LOGIN_HASH, college: 'MAIT' },
    });
  const organizer = await user('organizer@festpass.dev', 'Olivia Organizer');
  const scanner = await user('scanner@festpass.dev', 'Sam Scanner');
  const sponsorUser = await user('sponsor@festpass.dev', 'Priya Sponsor');
  await user('attendee@festpass.dev', 'Aman Attendee');

  for (const [member, role] of [
    [organizer, 'OWNER'],
    [scanner, 'SCANNER'],
  ] as const) {
    await db.orgMember.upsert({
      where: { orgId_userId: { orgId: org.id, userId: member.id } },
      update: {},
      create: { orgId: org.id, userId: member.id, role },
    });
  }

  // Fixed dates (stored as UTC) keep the seed deterministic. 10:00 IST = 04:30 UTC.
  const event = await db.event.upsert({
    where: { slug: 'mait-alumni-meet-2026' },
    update: {},
    create: {
      orgId: org.id,
      title: 'MAIT Alumni Meet 2026',
      slug: 'mait-alumni-meet-2026',
      description: 'A day of talks, networking and a sponsor expo with MAIT alumni.',
      venue: 'MAIT Auditorium, Rohini, Delhi',
      startsAt: new Date('2026-12-12T04:30:00Z'),
      endsAt: new Date('2026-12-12T12:30:00Z'),
      saleStartsAt: new Date('2026-11-01T04:30:00Z'),
      saleEndsAt: new Date('2026-12-11T18:29:59Z'),
      status: 'PUBLISHED',
    },
  });

  const tiers = [
    { name: 'Early bird', pricePaise: 19_900, capacity: 100, perUserLimit: 4 },
    { name: 'Regular', pricePaise: 29_900, capacity: 300, perUserLimit: 4 },
    { name: 'VIP', pricePaise: 99_900, capacity: 50, perUserLimit: 2 },
  ];
  for (const tier of tiers) {
    await db.ticketTier.upsert({
      where: { eventId_name: { eventId: event.id, name: tier.name } },
      update: {},
      create: { eventId: event.id, ...tier },
    });
  }

  const sponsor = await db.sponsor.upsert({
    where: { eventId_name: { eventId: event.id, name: 'CodeCraft Labs' } },
    update: {},
    create: { eventId: event.id, name: 'CodeCraft Labs', tier: 'GOLD' },
  });
  await db.sponsorMember.upsert({
    where: { sponsorId_userId: { sponsorId: sponsor.id, userId: sponsorUser.id } },
    update: {},
    create: { sponsorId: sponsor.id, userId: sponsorUser.id },
  });
  await db.booth.upsert({
    where: { sponsorId_name: { sponsorId: sponsor.id, name: 'Main stall' } },
    update: {},
    create: { sponsorId: sponsor.id, name: 'Main stall' },
  });
}

// Run directly (pnpm db:seed); importing the module from a test does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seed(prisma);
    console.log('seed complete');
  } finally {
    await prisma.$disconnect();
  }
}
