import { prisma, Prisma } from '@festpass/db';
import type { SponsorTier } from '@festpass/shared';

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const sponsorSelect = {
  id: true,
  name: true,
  tier: true,
  booths: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
  members: {
    select: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { email: 'asc' } },
  },
} satisfies Prisma.SponsorSelect;

export function eventInOrg(orgId: string, eventId: string) {
  return prisma.event.findFirst({ where: { id: eventId, orgId }, select: { id: true } });
}

export function listEventSponsors(eventId: string) {
  return prisma.sponsor.findMany({
    where: { eventId },
    select: sponsorSelect,
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });
}

/** The sponsor only if it belongs to this event, so one event's URL can't reach another's sponsors. */
export function findEventSponsor(eventId: string, sponsorId: string) {
  return prisma.sponsor.findFirst({ where: { id: sponsorId, eventId }, select: sponsorSelect });
}

/** Null when the event already has a sponsor with this name. */
export async function createSponsor(eventId: string, name: string, tier: SponsorTier) {
  try {
    return await prisma.sponsor.create({ data: { eventId, name, tier }, select: sponsorSelect });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** Null when the sponsor already has a booth with this name. */
export async function createBooth(sponsorId: string, name: string) {
  try {
    return await prisma.booth.create({
      data: { sponsorId, name },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** False when the user is already one of the sponsor's users. */
export async function addSponsorMember(sponsorId: string, userId: string) {
  try {
    await prisma.sponsorMember.create({ data: { sponsorId, userId } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

export async function removeSponsorMember(sponsorId: string, userId: string) {
  const { count } = await prisma.sponsorMember.deleteMany({ where: { sponsorId, userId } });
  return count === 1;
}

/** Booths a scanner can open at this event, with their sponsor's name. */
export function listEventBooths(eventId: string) {
  return prisma.booth.findMany({
    where: { sponsor: { eventId } },
    select: { id: true, name: true, sponsor: { select: { name: true } } },
    orderBy: [{ sponsor: { name: 'asc' } }, { name: 'asc' }],
  });
}

export function findBoothForScan(boothId: string) {
  return prisma.booth.findUnique({
    where: { id: boothId },
    select: {
      id: true,
      sponsor: { select: { event: { select: { id: true, orgId: true, status: true } } } },
    },
  });
}

const sponsorshipSelect = {
  id: true,
  name: true,
  tier: true,
  event: { select: { id: true, title: true, startsAt: true, status: true } },
  booths: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.SponsorSelect;

/** Every sponsor this user belongs to. The membership row is the whole access rule. */
export function listSponsorships(userId: string) {
  return prisma.sponsor.findMany({
    where: { members: { some: { userId } } },
    select: sponsorshipSelect,
    orderBy: { event: { startsAt: 'desc' } },
  });
}

/** The sponsor, only if this user is one of its users. */
export function findSponsorForMember(sponsorId: string, userId: string) {
  return prisma.sponsor.findFirst({
    where: { id: sponsorId, members: { some: { userId } } },
    select: sponsorshipSelect,
  });
}

export function sponsorIdsOfEvent(eventId: string) {
  return prisma.sponsor.findMany({ where: { eventId }, select: { id: true } });
}
