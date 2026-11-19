import { prisma, type Prisma } from '@festpass/db';

const ticketSelect = {
  id: true,
  code: true,
  seq: true,
  qrVersion: true,
  checkedInAt: true,
  createdAt: true,
  orderId: true,
  ownerUserId: true,
  tier: { select: { id: true, name: true } },
  order: {
    select: {
      event: { select: { id: true, title: true, slug: true, venue: true, startsAt: true } },
    },
  },
} satisfies Prisma.TicketSelect;

export type TicketRecord = Prisma.TicketGetPayload<{ select: typeof ticketSelect }>;

/** The user's tickets, soonest event first. */
export function findTicketsForOwner(userId: string) {
  return prisma.ticket.findMany({
    where: { ownerUserId: userId },
    select: ticketSelect,
    orderBy: [{ order: { event: { startsAt: 'asc' } } }, { orderId: 'asc' }, { seq: 'asc' }],
  });
}

export function findTicket(ticketId: string) {
  return prisma.ticket.findUnique({ where: { id: ticketId }, select: ticketSelect });
}
