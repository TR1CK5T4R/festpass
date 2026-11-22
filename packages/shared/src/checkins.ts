import { z } from 'zod';

export const SCAN_RESULTS = ['ACCEPTED', 'DUPLICATE', 'INVALID', 'REVOKED'] as const;
export type ScanResult = (typeof SCAN_RESULTS)[number];

const qr = z.string().min(1).max(1000);
const deviceId = z.string().trim().min(1).max(100);
const gateId = z.string().trim().min(1).max(100).default('main');
/** Chosen by the phone. Sent again if the answer was lost, so the same scan is never a false conflict. */
const clientScanId = z.string().min(1).max(100);

export const checkinSchema = z.object({
  qr,
  deviceId,
  gateId,
  clientScanId: clientScanId.optional(),
});
export type CheckinInput = z.infer<typeof checkinSchema>;

// 200 scans of about 350 bytes each stay well under the API's 100 kB body limit; a phone with a longer
// queue sends several batches.
export const batchCheckinSchema = z.object({
  deviceId,
  gateId,
  scans: z
    .array(
      z.object({
        clientScanId,
        qr,
        /** When the phone scanned it (the phone's clock). */
        scannedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
      }),
    )
    .min(1)
    .max(200),
});
export type BatchCheckinInput = z.infer<typeof batchCheckinSchema>;

/** Who first scanned a ticket that is scanned again. */
export interface FirstScan {
  firstScannedAt: string;
  firstScannedBy: { id: string; name: string } | null;
}

/** What the gate needs to see for an accepted ticket. */
export interface CheckedInTicket {
  id: string;
  code: string;
  tierName: string;
  attendeeName: string;
  checkedInAt: string;
}

/** One entry of the batch answer, in the order the scans were processed (client timestamp). */
export type BatchScanResult = { clientScanId: string } & (
  | { result: 'ACCEPTED'; ticket: CheckedInTicket }
  | ({ result: 'DUPLICATE'; ticketId: string } & FirstScan)
  | { result: 'INVALID' | 'REVOKED'; code: string; message: string }
);

/**
 * What a scanner downloads at gate open: enough to catch revoked and already-used tickets offline, with
 * no personal data, so a lost phone gives nothing away.
 */
export interface GateManifest {
  eventId: string;
  generatedAt: string;
  tickets: { id: string; v: number; used: boolean }[];
}
