import { bumpQrVersion } from '@festpass/db/tickets';
import type { TicketView } from '@festpass/shared';
import { createTicketSigner } from '@festpass/shared/server';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import * as repo from './repository.js';

const encodeTicket = createTicketSigner(env.TICKET_SIGNING_PRIVATE_KEY);

/**
 * The QR string is signed when it is read, not stored: it is fully determined by the ticket (ID,
 * event, current version, issue time) and Ed25519 is deterministic, so every read gives the same string
 * until the version changes. Nothing derived from the key sits in the database.
 */
function toView(ticket: repo.TicketRecord): TicketView {
  const event = ticket.order.event;
  return {
    id: ticket.id,
    code: ticket.code,
    seq: ticket.seq,
    qrVersion: ticket.qrVersion,
    qr: encodeTicket({
      t: ticket.id,
      e: event.id,
      v: ticket.qrVersion,
      iat: Math.floor(ticket.createdAt.getTime() / 1000),
    }),
    checkedInAt: ticket.checkedInAt?.toISOString() ?? null,
    orderId: ticket.orderId,
    tier: ticket.tier,
    event: { ...event, startsAt: event.startsAt.toISOString() },
  };
}

export async function listMyTickets(userId: string): Promise<TicketView[]> {
  return (await repo.findTicketsForOwner(userId)).map(toView);
}

async function findOwnTicket(userId: string, ticketId: string) {
  const ticket = await repo.findTicket(ticketId);
  // Someone else's ticket looks exactly like a missing one, so ticket IDs can't be probed.
  if (!ticket || ticket.ownerUserId !== userId) throw new NotFoundError('Ticket not found');
  return ticket;
}

export async function getMyTicket(userId: string, ticketId: string): Promise<TicketView> {
  return toView(await findOwnTicket(userId, ticketId));
}

/**
 * A new QR for a ticket whose code was shared or leaked: bumps qr_version, so the gate (Day 19)
 * rejects every earlier QR of this ticket. Not possible once the ticket has been used.
 */
export async function reissueQr(userId: string, ticketId: string): Promise<TicketView> {
  await findOwnTicket(userId, ticketId);
  if ((await bumpQrVersion(ticketId)) === null) {
    throw new ConflictError('TICKET_USED', 'This ticket has already been used at the gate');
  }
  return toView((await repo.findTicket(ticketId))!);
}
