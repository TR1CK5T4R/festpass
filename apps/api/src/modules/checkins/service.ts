import { checkInTicket, findTicketForGate } from '@festpass/db/tickets';
import { recordScanEvent, type ScanEventData } from '@festpass/mongo';
import {
  JOBS,
  verifyTicket,
  type BatchCheckinInput,
  type BatchScanResult,
  type CheckedInTicket,
  type CheckinInput,
  type FirstScan,
} from '@festpass/shared';
import { ticketPublicKey } from '@festpass/shared/server';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { scansQueue } from '../../lib/queues.js';

const publicKey = ticketPublicKey(env.TICKET_SIGNING_PRIVATE_KEY);

export type ScanOutcome =
  | { result: 'ACCEPTED'; ticket: CheckedInTicket }
  | ({ result: 'DUPLICATE'; ticketId: string } & FirstScan)
  | { result: 'INVALID' | 'REVOKED'; code: string; message: string };

interface ScanContext {
  eventId: string;
  scannerUserId: string;
  deviceId: string;
  gateId: string;
  offline: boolean;
  /** When the scan happened: now, or the phone's time for an offline scan. */
  ts: Date;
}

const rejected = (result: 'INVALID' | 'REVOKED', code: string, message: string): ScanOutcome => ({
  result,
  code,
  message,
});

const firstScan = (ticket: {
  checkedInAt: Date | null;
  checkedInUser: FirstScan['firstScannedBy'];
}): FirstScan => ({
  firstScannedAt: ticket.checkedInAt!.toISOString(),
  firstScannedBy: ticket.checkedInUser,
});

/**
 * Postgres decides entry: signature, then event, then version, then one guarded UPDATE. Afterwards,
 * whatever the answer, the scan goes to MongoDB as history.
 */
async function scan(qr: string, context: ScanContext): Promise<ScanOutcome> {
  const fields: Pick<
    ScanEventData,
    'ticketId' | 'college' | 'branch' | 'graduationYear' | 'tierName'
  > = {
    ticketId: null,
    college: null,
    branch: null,
    graduationYear: null,
    tierName: null,
  };
  const outcome = await decide(qr, context.eventId, context.scannerUserId, fields);
  // Not awaited: the volunteer at the gate must not wait for analytics, and the decision is already
  // committed. shortcut: a write in flight when the process stops is lost; drain them on shutdown if
  // scan counts ever need to be exact across deploys.
  void persistScan({
    ts: context.ts,
    meta: { eventId: context.eventId, type: 'GATE', gateOrBoothId: context.gateId },
    scannerUserId: context.scannerUserId,
    deviceId: context.deviceId,
    offline: context.offline,
    result: outcome.result,
    ...fields,
  });
  return outcome;
}

async function decide(
  qr: string,
  eventId: string,
  scannerUserId: string,
  fields: Partial<ScanEventData>,
): Promise<ScanOutcome> {
  const verified = await verifyTicket(qr, publicKey);
  if (!verified.valid)
    return rejected('INVALID', 'INVALID_QR', 'This is not a valid FestPass ticket');
  const { t: ticketId, e: qrEventId, v: qrVersion } = verified.payload;

  fields.ticketId = ticketId; // signed by us, so it can be trusted from here on
  if (qrEventId !== eventId)
    return rejected('INVALID', 'WRONG_EVENT', 'This ticket is for a different event');

  const ticket = await findTicketForGate(ticketId);
  if (!ticket || ticket.order.eventId !== eventId) {
    return rejected('INVALID', 'INVALID_QR', 'This is not a valid FestPass ticket');
  }
  fields.college = ticket.owner.college;
  fields.branch = ticket.owner.branch;
  fields.graduationYear = ticket.owner.graduationYear;
  fields.tierName = ticket.tier.name;

  const revoked = () =>
    rejected('REVOKED', 'QR_REVOKED', 'This QR was replaced by a newer one; ask for the latest');
  if (qrVersion !== ticket.qrVersion) return revoked();

  const checkedInAt = await checkInTicket(ticketId, qrVersion, scannerUserId);
  if (checkedInAt) {
    return {
      result: 'ACCEPTED',
      ticket: {
        id: ticket.id,
        code: ticket.code,
        tierName: ticket.tier.name,
        attendeeName: ticket.owner.name,
        checkedInAt: checkedInAt.toISOString(),
      },
    };
  }
  // Didn't win: read again, because the state may have changed since the read above.
  const current = await findTicketForGate(ticketId);
  return current?.checkedInAt
    ? { result: 'DUPLICATE', ticketId, ...firstScan(current) }
    : revoked();
}

/**
 * Writes the scan event, after the check-in has committed. If MongoDB fails, a queue job tries again
 * with long backoff (the worker). The check-in is never undone: a gate must keep working during a
 * MongoDB outage, and a late analytics row is far better than a person sent back.
 */
async function persistScan(event: ScanEventData) {
  try {
    await recordScanEvent(event);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, ticketId: event.ticketId },
      'scan event write failed, queuing a retry',
    );
    try {
      await scansQueue.add(JOBS.writeScanEvent, event, {
        attempts: 10,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } catch (queueErr) {
      logger.error(
        { err: (queueErr as Error).message, ticketId: event.ticketId },
        'scan event lost',
      );
    }
  }
}

export function checkIn(eventId: string, scannerUserId: string, input: CheckinInput) {
  return scan(input.qr, {
    eventId,
    scannerUserId,
    deviceId: input.deviceId,
    gateId: input.gateId,
    offline: false,
    ts: new Date(),
  });
}

/**
 * Offline sync. Scans run one at a time in the phones' timestamp order, so the earliest scan of a ticket
 * in the batch is the one accepted. The clock in the phone is not trusted for anything but ordering and
 * the event's time, and a time in the future becomes now.
 * shortcut: a batch re-sent after a lost response reports its scans as DUPLICATE and logs them again;
 * recognise a re-sent clientScanId if that skews reports.
 */
export async function checkInBatch(
  eventId: string,
  scannerUserId: string,
  input: BatchCheckinInput,
): Promise<BatchScanResult[]> {
  const ordered = [...input.scans].sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime());
  const results: BatchScanResult[] = [];
  for (const { clientScanId, qr, scannedAt } of ordered) {
    const now = new Date();
    const outcome = await scan(qr, {
      eventId,
      scannerUserId,
      deviceId: input.deviceId,
      gateId: input.gateId,
      offline: true,
      ts: scannedAt > now ? now : scannedAt,
    });
    results.push({ clientScanId, ...outcome });
  }
  return results;
}
