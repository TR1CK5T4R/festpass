import { bumpQrVersion } from '@festpass/db/tickets';
import { storageKeys, ticketQrPayload, type TicketView } from '@festpass/shared';
import { createTicketSigner } from '@festpass/shared/server';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { headObject, signedDownloadUrl } from '../../lib/storage.js';
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
    qr: encodeTicket(ticketQrPayload({ ...ticket, eventId: event.id })),
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

/** Download links are short: the page asks for a new one on every click, so it never needs to last. */
const DOWNLOAD_LINK_SECONDS = 5 * 60;

/**
 * A fresh link to the order's PDF tickets. The PDF is private (not under the public banner prefix), so
 * the only way to it is a pre-signed GET made for the owner, valid for 5 minutes.
 */
export async function ticketPdfLink(userId: string, orderId: string) {
  const order = await repo.findOrderForPdf(orderId);
  if (!order || order.userId !== userId) throw new NotFoundError('Order not found');
  const key = storageKeys.ticketPdf(order.event.orgId, order.event.id, order.id);
  // Built by the worker right after the tickets are issued; there is a short gap before it exists.
  if (order.status !== 'TICKETED' || !(await headObject(key))) {
    throw new ConflictError(
      'PDF_NOT_READY',
      'Your PDF tickets are still being prepared; try again in a moment',
    );
  }
  return {
    url: await signedDownloadUrl(key, DOWNLOAD_LINK_SECONDS, `festpass-${order.event.slug}.pdf`),
    expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000).toISOString(),
  };
}
