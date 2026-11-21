import { SCAN_RESULTS, type ScanResult } from '@festpass/shared';
import mongoose, { Schema } from 'mongoose';

/**
 * One scan at a gate or booth, whatever its result. History for analytics: Postgres alone decides who
 * gets in. The attendee's college, branch, year and tier are copied at write time, so dashboards are
 * single aggregations here, with no join back to Postgres, and they keep what was true on the day.
 */
export interface ScanEventData {
  ts: Date;
  meta: { eventId: string; type: 'GATE' | 'BOOTH'; gateOrBoothId: string };
  /** Null when the QR couldn't be trusted, so nothing in it is recorded. */
  ticketId: string | null;
  scannerUserId: string;
  deviceId: string;
  result: ScanResult;
  offline: boolean;
  college: string | null;
  branch: string | null;
  graduationYear: number | null;
  tierName: string | null;
}

const scanEventSchema = new Schema<ScanEventData>(
  {
    ts: { type: Date, required: true },
    meta: {
      eventId: { type: String, required: true },
      type: { type: String, enum: ['GATE', 'BOOTH'], required: true },
      gateOrBoothId: { type: String, required: true },
    },
    ticketId: { type: String, default: null },
    scannerUserId: { type: String, required: true },
    deviceId: { type: String, required: true },
    result: { type: String, enum: SCAN_RESULTS, required: true },
    offline: { type: Boolean, required: true },
    college: { type: String, default: null },
    branch: { type: String, default: null },
    graduationYear: { type: Number, default: null },
    tierName: { type: String, default: null },
  },
  {
    collection: 'scan_events',
    versionKey: false,
    // Time-series: MongoDB groups documents with the same meta into compressed buckets ordered by time,
    // which suits many small append-only writes that are read back as "per gate, per minute".
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
  },
);

export const ScanEvent = mongoose.model<ScanEventData>('ScanEvent', scanEventSchema);

export async function recordScanEvent(event: ScanEventData): Promise<void> {
  await ScanEvent.create(event);
}
