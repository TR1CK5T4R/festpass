import { prisma, Prisma } from '@festpass/db';
import type { EventStatus } from '@festpass/shared';
import type { EventCursor } from '../../lib/cursor.js';

const tierSelect = {
  id: true,
  name: true,
  pricePaise: true,
  capacity: true,
  soldCount: true,
  perUserLimit: true,
  saleStartsAt: true,
  saleEndsAt: true,
} satisfies Prisma.TicketTierSelect;

const eventSelect = {
  id: true,
  orgId: true,
  title: true,
  slug: true,
  description: true,
  venue: true,
  startsAt: true,
  endsAt: true,
  saleStartsAt: true,
  saleEndsAt: true,
  status: true,
  bannerKey: true,
  queueMode: true,
  admitRatePerSec: true,
  tiers: { select: tierSelect, orderBy: [{ pricePaise: 'asc' }, { name: 'asc' }] },
} satisfies Prisma.EventSelect;

export type EventRecord = Prisma.EventGetPayload<{ select: typeof eventSelect }>;
export type TierRecord = EventRecord['tiers'][number];

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Null when the slug is taken (unique index), so the service can retry with a suffix. */
export async function createEvent(
  data: Prisma.EventUncheckedCreateInput,
): Promise<EventRecord | null> {
  try {
    return await prisma.event.create({ data, select: eventSelect });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** The event only if it belongs to this org, so one org can never reach another org's events by ID. */
export function findOrgEvent(orgId: string, eventId: string) {
  return prisma.event.findFirst({ where: { id: eventId, orgId }, select: eventSelect });
}

export function findEventOrg(eventId: string) {
  return prisma.event.findUnique({ where: { id: eventId }, select: { orgId: true } });
}

export function findPublicEventBySlug(slug: string) {
  return prisma.event.findFirst({
    // Drafts never leave the organizer dashboard.
    where: { slug, status: { in: ['PUBLISHED', 'CLOSED'] } },
    select: { ...eventSelect, org: { select: { id: true, name: true, slug: true } } },
  });
}

/**
 * One page ordered by (starts_at, id). The cursor condition "after this row" is
 * starts_at > c.starts_at OR (starts_at = c.starts_at AND id > c.id), which stays correct when rows are
 * inserted between page loads, unlike OFFSET. Fetches limit + 1 rows to know if there is a next page.
 */
export function listEvents(
  where: Prisma.EventWhereInput,
  cursor: EventCursor | null,
  limit: number,
) {
  const after: Prisma.EventWhereInput = cursor
    ? {
        OR: [
          { startsAt: { gt: cursor.startsAt } },
          { startsAt: cursor.startsAt, id: { gt: cursor.id } },
        ],
      }
    : {};
  return prisma.event.findMany({
    where: { AND: [where, after] },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: {
      id: true,
      orgId: true,
      title: true,
      slug: true,
      venue: true,
      startsAt: true,
      endsAt: true,
      saleStartsAt: true,
      saleEndsAt: true,
      status: true,
      bannerKey: true,
      org: { select: { name: true, slug: true } },
      // Only for the sold/capacity totals; small (an event has a handful of tiers).
      tiers: { select: { capacity: true, soldCount: true } },
    },
  });
}

export function updateEvent(eventId: string, data: Prisma.EventUpdateInput) {
  return prisma.event.update({ where: { id: eventId }, data, select: eventSelect });
}

/** Guarded status change: matches nothing if another request changed the status first. */
export async function transitionStatus(eventId: string, from: EventStatus, to: EventStatus) {
  const { count } = await prisma.event.updateMany({
    where: { id: eventId, status: from },
    data: { status: to },
  });
  return count === 1;
}

/** Null when a tier with this name already exists for the event. */
export async function createTier(data: Prisma.TicketTierUncheckedCreateInput) {
  try {
    return await prisma.ticketTier.create({ data, select: tierSelect });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * Locks the tier row (FOR UPDATE), lets `decide` check the rules against the current row, then applies
 * its changes. The booking engine's UPDATE of sold_count takes the same lock, so a sale can't slip in
 * between "no tickets sold yet" and "change the price". Returns null if the tier doesn't exist.
 * `decide` may throw to refuse the change.
 */
export function updateTierLocked(
  eventId: string,
  tierId: string,
  decide: (current: TierRecord) => Prisma.TicketTierUpdateInput,
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM ticket_tiers WHERE id = ${tierId}::uuid AND event_id = ${eventId}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
    const current = await tx.ticketTier.findUniqueOrThrow({
      where: { id: tierId },
      select: tierSelect,
    });
    return tx.ticketTier.update({
      where: { id: tierId },
      data: decide(current),
      select: tierSelect,
    });
  });
}

/** Deletes a tier only while nothing has been sold from it. */
export async function deleteUnsoldTier(
  eventId: string,
  tierId: string,
): Promise<'OK' | 'NOT_FOUND' | 'HAS_SALES'> {
  const { count } = await prisma.ticketTier.deleteMany({
    where: { id: tierId, eventId, soldCount: 0 },
  });
  if (count === 1) return 'OK';
  const exists = await prisma.ticketTier.count({ where: { id: tierId, eventId } });
  return exists ? 'HAS_SALES' : 'NOT_FOUND';
}
