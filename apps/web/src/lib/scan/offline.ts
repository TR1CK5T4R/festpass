import { verifyTicket, type BatchScanResult, type GateManifest } from '@festpass/shared';

// The scanner's offline rules, free of IndexedDB and React so they can be tested with plain objects.

export type ManifestIndex = Map<string, { v: number; used: boolean }>;

export const indexManifest = (manifest: GateManifest): ManifestIndex =>
  new Map(manifest.tickets.map((t) => [t.id, { v: t.v, used: t.used }]));

export type ScanStatus =
  /** Let in offline; the server hasn't heard yet. */
  | 'QUEUED'
  /** The server agrees (or it was scanned online). */
  | 'SYNCED'
  /** Someone else scanned this ticket first. */
  | 'CONFLICT'
  /** The server refused it: the QR was replaced, or the ticket doesn't exist. */
  | 'REJECTED';

export interface StoredScan {
  clientScanId: string;
  eventId: string;
  gateId: string;
  ticketId: string;
  qr: string;
  scannedAt: string;
  status: ScanStatus;
  /** For a conflict: who got there first. */
  firstScannedAt?: string;
  firstScannedBy?: string | null;
  /** For a rejected scan: why. */
  message?: string;
}

export interface ScanStore {
  scansOfTicket(eventId: string, ticketId: string): Promise<StoredScan[]>;
  addScan(scan: StoredScan): Promise<void>;
  /** Everything not yet sent, oldest first. */
  queuedScans(): Promise<StoredScan[]>;
  updateScan(clientScanId: string, changes: Partial<StoredScan>): Promise<void>;
}

/**
 * A scan the server refused doesn't count: the person may come back with the current QR for that
 * ticket, and that one deserves a fresh look.
 */
export async function scannedOnThisDevice(store: ScanStore, eventId: string, ticketId: string) {
  const scans = await store.scansOfTicket(eventId, ticketId);
  return scans.find((s) => s.status !== 'REJECTED') ?? null;
}

export type OfflineVerdict =
  | { result: 'ACCEPTED'; ticketId: string }
  | { result: 'DUPLICATE'; ticketId: string }
  | { result: 'REVOKED'; ticketId: string; message: string }
  | { result: 'INVALID'; code: 'INVALID_QR' | 'WRONG_EVENT'; message: string };

interface OfflineScan {
  store: ScanStore;
  publicKey: string;
  eventId: string;
  gateId: string;
  /** Null until the first download succeeds; signature checks still work without it. */
  manifest: ManifestIndex | null;
  clientScanId: string;
  now: Date;
}

/** Decides a scan with no server, and queues it if it passes. The same order of checks as the API. */
export async function scanOffline(
  qr: string,
  { store, publicKey, eventId, gateId, manifest, clientScanId, now }: OfflineScan,
): Promise<OfflineVerdict> {
  const verified = await verifyTicket(qr, publicKey);
  if (!verified.valid) {
    return {
      result: 'INVALID',
      code: 'INVALID_QR',
      message: 'This is not a valid FestPass ticket',
    };
  }
  const { t: ticketId, e: qrEventId, v: qrVersion } = verified.payload;
  if (qrEventId !== eventId) {
    return {
      result: 'INVALID',
      code: 'WRONG_EVENT',
      message: 'This ticket is for a different event',
    };
  }

  const known = manifest?.get(ticketId);
  // Only "older than the list" is revoked. Newer means it was reissued after the last download, and a
  // ticket not on the list was sold after it: both are signed by us, so let them in and let the server
  // have the last word at sync.
  if (known && qrVersion < known.v) {
    return {
      result: 'REVOKED',
      ticketId,
      message: 'This QR was replaced by a newer one; ask for the latest',
    };
  }
  if (known?.used || (await scannedOnThisDevice(store, eventId, ticketId))) {
    return { result: 'DUPLICATE', ticketId };
  }

  await store.addScan({
    clientScanId,
    eventId,
    gateId,
    ticketId,
    qr,
    scannedAt: now.toISOString(),
    status: 'QUEUED',
  });
  return { result: 'ACCEPTED', ticketId };
}

export interface ScanBatch {
  gateId: string;
  scans: { clientScanId: string; qr: string; scannedAt: string }[];
}
export type SendBatch = (eventId: string, batch: ScanBatch) => Promise<BatchScanResult[]>;

/** The API's limit per batch (batchCheckinSchema). */
const BATCH_SIZE = 200;

function outcome(result: BatchScanResult): Partial<StoredScan> {
  switch (result.result) {
    case 'ACCEPTED':
      return { status: 'SYNCED' };
    case 'DUPLICATE':
      return {
        status: 'CONFLICT',
        firstScannedAt: result.firstScannedAt,
        firstScannedBy: result.firstScannedBy?.name ?? null,
      };
    default:
      return { status: 'REJECTED', message: result.message };
  }
}

/**
 * Sends the queue, oldest first, and writes down each answer as it arrives. If a request fails this
 * rejects and the rest stay queued for the next try. Sending a scan twice is safe: the server recognises
 * its clientScanId and gives the same answer.
 */
export async function syncQueue(store: ScanStore, send: SendBatch): Promise<void> {
  // One request per event and gate, because the batch endpoint takes one of each.
  const groups = new Map<string, StoredScan[]>();
  for (const scan of await store.queuedScans()) {
    const key = `${scan.eventId} ${scan.gateId}`;
    groups.set(key, [...(groups.get(key) ?? []), scan]);
  }
  for (const scans of groups.values()) {
    for (let i = 0; i < scans.length; i += BATCH_SIZE) {
      const chunk = scans.slice(i, i + BATCH_SIZE);
      const { eventId, gateId } = chunk[0]!;
      const results = await send(eventId, {
        gateId,
        scans: chunk.map(({ clientScanId, qr, scannedAt }) => ({ clientScanId, qr, scannedAt })),
      });
      for (const result of results) await store.updateScan(result.clientScanId, outcome(result));
    }
  }
}
