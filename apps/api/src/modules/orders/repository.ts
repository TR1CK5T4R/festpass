import { prisma } from '@festpass/db';
import type { OrderDetails, OrderView } from '@festpass/shared';

/** What the pre-checks and the gate need: the event's status and sale window, and its tiers. */
export function findEventForBooking(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: {
      status: true,
      saleStartsAt: true,
      saleEndsAt: true,
      queueMode: true,
      tiers: {
        select: { id: true, name: true, perUserLimit: true, saleStartsAt: true, saleEndsAt: true },
      },
    },
  });
}

/** An order as the API shows it, its owner (for the ownership check) and its event. */
export async function findOrder(
  orderId: string,
): Promise<{ userId: string; view: OrderView; event: OrderDetails['event'] } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      eventId: true,
      status: true,
      amountPaise: true,
      expiresAt: true,
      event: { select: { id: true, title: true, slug: true, venue: true, startsAt: true } },
      items: {
        select: { tierId: true, qty: true, unitPricePaise: true, tier: { select: { name: true } } },
        orderBy: { tierId: 'asc' },
      },
    },
  });
  if (!order) return null;
  const { userId, expiresAt, items, event, ...rest } = order;
  return {
    userId,
    event: { ...event, startsAt: event.startsAt.toISOString() },
    view: {
      ...rest,
      expiresAt: expiresAt.toISOString(),
      items: items.map(({ tier, ...item }) => ({ ...item, tierName: tier.name })),
    },
  };
}
