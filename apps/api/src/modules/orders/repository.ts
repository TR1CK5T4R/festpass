import { prisma } from '@festpass/db';
import type { OrderView } from '@festpass/shared';

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

/** An order as the API shows it, and its owner (for the ownership check). */
export async function findOrder(
  orderId: string,
): Promise<{ userId: string; view: OrderView } | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      eventId: true,
      status: true,
      amountPaise: true,
      expiresAt: true,
      items: {
        select: { tierId: true, qty: true, unitPricePaise: true, tier: { select: { name: true } } },
        orderBy: { tierId: 'asc' },
      },
    },
  });
  if (!order) return null;
  const { userId, expiresAt, items, ...rest } = order;
  return {
    userId,
    view: {
      ...rest,
      expiresAt: expiresAt.toISOString(),
      items: items.map(({ tier, ...item }) => ({ ...item, tierName: tier.name })),
    },
  };
}
