import { randomUUID } from 'node:crypto';
import { connectMongo, disconnectMongo, ScanEvent } from '@festpass/mongo';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeScanEvent } from '../src/processors.js';

const deps = { log: pino({ level: 'silent' }) };

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
afterAll(() => disconnectMongo());

/** The job data as BullMQ stores it: JSON, so the time is a string. */
const job = (eventId: string) => ({
  ts: new Date('2026-12-04T05:00:00Z').toISOString(),
  meta: { eventId, type: 'GATE', gateOrBoothId: 'main' },
  ticketId: randomUUID(),
  scannerUserId: randomUUID(),
  deviceId: 'phone-1',
  result: 'ACCEPTED',
  offline: false,
  college: 'MAIT',
  branch: null,
  graduationYear: 2027,
  tierName: 'Regular',
});

describe('write-scan-event', () => {
  it('writes the scan to MongoDB at its original time', async () => {
    const eventId = randomUUID();

    expect(await writeScanEvent(job(eventId), deps)).toEqual({ written: true });

    const [event] = await ScanEvent.find({ 'meta.eventId': eventId }).lean();
    expect(event).toMatchObject({
      ts: new Date('2026-12-04T05:00:00Z'),
      result: 'ACCEPTED',
      college: 'MAIT',
    });
  });

  it('rejects a malformed payload instead of writing it', async () => {
    await expect(writeScanEvent({ result: 'ACCEPTED' }, deps)).rejects.toThrow();
  });
});
