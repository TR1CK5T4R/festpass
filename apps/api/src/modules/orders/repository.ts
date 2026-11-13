import { prisma } from '@festpass/db';

/** What the pre-checks need: the event's status and sale windows, and its tiers' windows. */
export function findEventForBooking(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: {
      status: true,
      saleStartsAt: true,
      saleEndsAt: true,
      tiers: { select: { id: true, saleStartsAt: true, saleEndsAt: true } },
    },
  });
}
