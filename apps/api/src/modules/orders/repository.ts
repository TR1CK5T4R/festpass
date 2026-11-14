import { prisma } from '@festpass/db';

/** What the pre-checks and the gate need: the event's status and sale window, and its tiers. */
export function findEventForBooking(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: {
      status: true,
      saleStartsAt: true,
      saleEndsAt: true,
      tiers: {
        select: { id: true, name: true, perUserLimit: true, saleStartsAt: true, saleEndsAt: true },
      },
    },
  });
}
