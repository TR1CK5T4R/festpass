import { randomInt } from 'node:crypto';
import { prisma } from './index.js';
import { transition, type OrderStatus } from './order-state.js';

// Unambiguous letters and digits (no 0/O, 1/I/L), so a code read out at the gate is typed correctly.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short code people can read out, e.g. "K7QM-X9PA": 31^8 ≈ 850 billion combinations. */
function ticketCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Issues a paid order's tickets: one per unit, numbered 1..n across the order, then PAID -> TICKETED,
 * in one transaction. Safe to run any number of times: the order row is locked and only a PAID order
 * gets tickets, and unique(order_id, seq) would reject a second ticket #2 even if that check failed.
 * (A clash on the random code itself fails the transaction; the job retries with new codes.)
 */
export async function issueTickets(
  orderId: string,
): Promise<{ issued: number; status: OrderStatus } | null> {
  return prisma.$transaction(async (tx) => {
    const [order] = await tx.$queryRaw<{ user_id: string; status: OrderStatus }[]>`
      SELECT user_id, status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    if (!order) return null;
    if (order.status !== 'PAID') return { issued: 0, status: order.status }; // done before, or not paid

    const items = await tx.$queryRaw<{ tier_id: string; qty: number }[]>`
      SELECT tier_id, qty FROM order_items WHERE order_id = ${orderId}::uuid ORDER BY tier_id`;
    let seq = 0;
    let issued = 0;
    for (const item of items) {
      for (let unit = 0; unit < item.qty; unit++) {
        seq++;
        issued += await tx.$executeRaw`
          INSERT INTO tickets (order_id, tier_id, owner_user_id, seq, code)
          VALUES (${orderId}::uuid, ${item.tier_id}::uuid, ${order.user_id}::uuid, ${seq}, ${ticketCode()})
          ON CONFLICT (order_id, seq) DO NOTHING`;
      }
    }
    await transition(tx, orderId, 'PAID', 'TICKETED');
    return { issued, status: 'TICKETED' };
  });
}

/**
 * Revocation: a new qr_version makes every QR printed or shared for an older version invalid at the
 * gate. Not for tickets already used. Returns the new version, or null if the ticket can't be changed.
 */
export async function bumpQrVersion(ticketId: string): Promise<number | null> {
  const [row] = await prisma.$queryRaw<{ qr_version: number }[]>`
    UPDATE tickets SET qr_version = qr_version + 1
    WHERE id = ${ticketId}::uuid AND checked_in_at IS NULL
    RETURNING qr_version`;
  return row?.qr_version ?? null;
}

/** What the gate needs to judge a ticket, and the attendee fields copied into the scan event. */
export function findTicketForGate(ticketId: string) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      code: true,
      qrVersion: true,
      checkedInAt: true,
      checkedInScanId: true,
      checkedInUser: { select: { id: true, name: true } },
      tier: { select: { name: true } },
      order: { select: { eventId: true } },
      owner: { select: { name: true, college: true, branch: true, graduationYear: true } },
    },
  });
}

/**
 * The decision at the gate, in one statement. The row lock serialises parallel scans, and a scan that
 * waited re-checks the WHERE clause against the winner's commit, so exactly one gets a row back, however
 * many phones scan the same ticket. qr_version is in the WHERE too, so a reissue racing a scan can't let
 * the old code in. Returns when it was accepted, or null if this scan didn't win.
 */
export async function checkInTicket(
  ticketId: string,
  qrVersion: number,
  scannerUserId: string,
  clientScanId: string | null = null,
): Promise<Date | null> {
  const [row] = await prisma.$queryRaw<{ checked_in_at: Date }[]>`
    UPDATE tickets
    SET checked_in_at = now(), checked_in_by = ${scannerUserId}::uuid, checked_in_scan_id = ${clientScanId}
    WHERE id = ${ticketId}::uuid AND qr_version = ${qrVersion} AND checked_in_at IS NULL
    RETURNING checked_in_at`;
  return row?.checked_in_at ?? null;
}

/** Every ticket of an event, for a scanner to keep offline: IDs and numbers only, no personal data. */
export async function listTicketsForGate(eventId: string) {
  const tickets = await prisma.ticket.findMany({
    where: { order: { eventId } },
    select: { id: true, qrVersion: true, checkedInAt: true },
  });
  return tickets.map((t) => ({ id: t.id, v: t.qrVersion, used: t.checkedInAt !== null }));
}

/** How many of an event's tickets exist and how many have been used, for the live counter. */
export async function countCheckins(eventId: string) {
  const where = { order: { eventId } };
  const [totalTickets, checkedIn] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.count({ where: { ...where, checkedInAt: { not: null } } }),
  ]);
  return { totalTickets, checkedIn };
}
