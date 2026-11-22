import { describe, expect, it } from 'vitest';
import { indexManifest, scanOffline, syncQueue, type ScanStore, type StoredScan } from './offline';

// Real signed QR strings, made once with a throwaway key pair whose private keys were not kept.
const EVENT = '11111111-1111-4111-8111-111111111111';
const TICKET_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TICKET_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLIC_KEY = 'jiwjWcieUGcbxE61bmNTqaQim4ODwNNURmqCLphYiVs';
const TICKET_1 =
  'FP1.eyJ0IjoiYWFhYWFhYWEtYWFhYS00YWFhLThhYWEtYWFhYWFhYWFhYWFhIiwiZSI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInYiOjEsImlhdCI6MTc5NTAwMDAwMH0.McKGVeFwzdqRfUsScha9aKTAkPvb48FCL8JWSzILrxrXRkHB8eQNyXAGNIVEl01slZ4dbHb2LrKMB8s4SrCzBw';
const TICKET_1_V2 =
  'FP1.eyJ0IjoiYWFhYWFhYWEtYWFhYS00YWFhLThhYWEtYWFhYWFhYWFhYWFhIiwiZSI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInYiOjIsImlhdCI6MTc5NTAwMDAwMH0.-dQCckclmBnCfbojSE6AG8w1Hivy2ZQQwFBm8MXbEtcEIzdWDWRaBub4-1DBCBkEj7TzdHVed73kxlz-ZonrCg';
const TICKET_2 =
  'FP1.eyJ0IjoiYmJiYmJiYmItYmJiYi00YmJiLThiYmItYmJiYmJiYmJiYmJiIiwiZSI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInYiOjEsImlhdCI6MTc5NTAwMDAwMH0.pHNlbSjtbQ8agFWsc_0tQPL9relNjWL_4I8WuxM-iwWloj07Po1KzwxflsUaBIS2ydG2NsqGZzVRi_zVdFgPCQ';
const OTHER_EVENT =
  'FP1.eyJ0IjoiYmJiYmJiYmItYmJiYi00YmJiLThiYmItYmJiYmJiYmJiYmJiIiwiZSI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiIsInYiOjEsImlhdCI6MTc5NTAwMDAwMH0.CUAPniEsTYt65dRS7fZStZ6xfWhv0dXRL7c-jXIYjLuO7ampwYH72GgbkwKgWjiOlxuyyrN3721sK7Q0DoofDw';
const OTHER_KEY =
  'FP1.eyJ0IjoiYWFhYWFhYWEtYWFhYS00YWFhLThhYWEtYWFhYWFhYWFhYWFhIiwiZSI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInYiOjEsImlhdCI6MTc5NTAwMDAwMH0.8pCuCOeVwORoJk-aQtuarDexiD2sP-I8r3QnWpHlkvBLBz3b3GwnQYbjAfLGZsepHkjUONjOko3JkUweL7Y6Bg';

function memoryStore(): ScanStore & { scans: StoredScan[] } {
  const scans: StoredScan[] = [];
  return {
    scans,
    scansOfTicket: async (eventId, ticketId) =>
      scans.filter((s) => s.eventId === eventId && s.ticketId === ticketId),
    addScan: async (scan) => void scans.push(scan),
    queuedScans: async () =>
      scans
        .filter((s) => s.status === 'QUEUED')
        .sort((a, b) => a.scannedAt.localeCompare(b.scannedAt)),
    updateScan: async (id, changes) => {
      Object.assign(
        scans.find((s) => s.clientScanId === id)!,
        changes,
      );
    },
  };
}

let nextId = 0;
const scan = (
  qr: string,
  store: ScanStore,
  manifest: Parameters<typeof scanOffline>[1]['manifest'] = null,
  now = new Date('2026-12-04T10:00:00Z'),
) =>
  scanOffline(qr, {
    store,
    publicKey: PUBLIC_KEY,
    eventId: EVENT,
    gateId: 'north',
    manifest,
    clientScanId: `scan-${++nextId}`,
    now,
  });

const manifestOf = (...tickets: { id: string; v: number; used: boolean }[]) =>
  indexManifest({ eventId: EVENT, generatedAt: '2026-12-04T09:00:00Z', tickets });

describe('local verification', () => {
  it('accepts a genuine ticket and queues it', async () => {
    const store = memoryStore();

    await expect(scan(TICKET_1, store)).resolves.toEqual({
      result: 'ACCEPTED',
      ticketId: TICKET_ID_1,
    });
    expect(store.scans).toMatchObject([
      {
        eventId: EVENT,
        gateId: 'north',
        ticketId: TICKET_ID_1,
        qr: TICKET_1,
        scannedAt: '2026-12-04T10:00:00.000Z',
        status: 'QUEUED',
      },
    ]);
  });

  it('refuses a ticket already scanned on this device, without queuing it again', async () => {
    const store = memoryStore();
    await scan(TICKET_1, store);

    await expect(scan(TICKET_1, store)).resolves.toMatchObject({ result: 'DUPLICATE' });
    expect(store.scans).toHaveLength(1);
  });

  it.each([
    ['not a ticket', 'hello'],
    ['signed with another key', OTHER_KEY],
    // Ticket 2's payload wearing ticket 1's signature: someone editing a QR.
    ['tampered', `FP1.${TICKET_2.split('.')[1]}.${TICKET_1.split('.')[2]}`],
  ])('refuses a QR that is %s', async (_, qr) => {
    const store = memoryStore();
    await expect(scan(qr, store)).resolves.toMatchObject({ result: 'INVALID', code: 'INVALID_QR' });
    expect(store.scans).toHaveLength(0);
  });

  it('refuses a genuine ticket for a different event', async () => {
    const store = memoryStore();
    await expect(scan(OTHER_EVENT, store)).resolves.toMatchObject({
      result: 'INVALID',
      code: 'WRONG_EVENT',
    });
    expect(store.scans).toHaveLength(0);
  });

  it('refuses a QR older than the downloaded ticket list', async () => {
    const store = memoryStore();
    const manifest = manifestOf({ id: TICKET_ID_1, v: 2, used: false });

    await expect(scan(TICKET_1, store, manifest)).resolves.toMatchObject({ result: 'REVOKED' });
    await expect(scan(TICKET_1_V2, store, manifest)).resolves.toMatchObject({ result: 'ACCEPTED' });
  });

  it('accepts a QR newer than the list, because the list may be out of date', async () => {
    const manifest = manifestOf({ id: TICKET_ID_1, v: 1, used: false });
    await expect(scan(TICKET_1_V2, memoryStore(), manifest)).resolves.toMatchObject({
      result: 'ACCEPTED',
    });
  });

  it('refuses a ticket the list says is used', async () => {
    const manifest = manifestOf({ id: TICKET_ID_1, v: 1, used: true });
    await expect(scan(TICKET_1, memoryStore(), manifest)).resolves.toMatchObject({
      result: 'DUPLICATE',
    });
  });

  it('accepts a signed ticket missing from the list: it may have been sold since', async () => {
    const manifest = manifestOf({ id: TICKET_ID_1, v: 1, used: false });
    await expect(scan(TICKET_2, memoryStore(), manifest)).resolves.toMatchObject({
      result: 'ACCEPTED',
      ticketId: TICKET_ID_2,
    });
  });

  it('lets the current QR through after the server refused an old one', async () => {
    const store = memoryStore();
    await scan(TICKET_1, store);
    await store.updateScan(store.scans[0]!.clientScanId, { status: 'REJECTED' });

    await expect(scan(TICKET_1_V2, store)).resolves.toMatchObject({ result: 'ACCEPTED' });
  });
});

const ticket = {
  id: TICKET_ID_1,
  code: 'FP-1',
  tierName: 'General',
  attendeeName: 'Asha',
  checkedInAt: '2026-12-04T10:00:00Z',
};

describe('syncQueue', () => {
  it('sends the queue oldest first and records each answer', async () => {
    const store = memoryStore();
    await scan(TICKET_2, store, null, new Date('2026-12-04T10:05:00Z'));
    await scan(TICKET_1, store, null, new Date('2026-12-04T10:01:00Z'));
    const sent: string[] = [];

    await syncQueue(store, async (eventId, batch) => {
      expect(eventId).toBe(EVENT);
      expect(batch.gateId).toBe('north');
      sent.push(...batch.scans.map((s) => s.qr));
      return batch.scans.map((s) => ({
        clientScanId: s.clientScanId,
        result: 'ACCEPTED' as const,
        ticket,
      }));
    });

    expect(sent).toEqual([TICKET_1, TICKET_2]);
    expect(store.scans.map((s) => s.status)).toEqual(['SYNCED', 'SYNCED']);
    await expect(store.queuedScans()).resolves.toEqual([]);
  });

  it('flags a conflict and a rejection with the reason', async () => {
    const store = memoryStore();
    await scan(TICKET_1, store);
    await scan(TICKET_2, store);
    const [first, second] = store.scans;

    await syncQueue(store, async () => [
      {
        clientScanId: first!.clientScanId,
        result: 'DUPLICATE',
        ticketId: TICKET_ID_1,
        firstScannedAt: '2026-12-04T09:00:00Z',
        firstScannedBy: { id: 'u1', name: 'Ravi' },
      },
      {
        clientScanId: second!.clientScanId,
        result: 'REVOKED',
        code: 'QR_REVOKED',
        message: 'Replaced',
      },
    ]);

    expect(first).toMatchObject({
      status: 'CONFLICT',
      firstScannedAt: '2026-12-04T09:00:00Z',
      firstScannedBy: 'Ravi',
    });
    expect(second).toMatchObject({ status: 'REJECTED', message: 'Replaced' });
  });

  it('keeps scans queued when the network fails, and sends them on the next try', async () => {
    const store = memoryStore();
    await scan(TICKET_1, store);

    await expect(
      syncQueue(store, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow('Failed to fetch');
    expect(store.scans[0]!.status).toBe('QUEUED');

    await syncQueue(store, async (_, batch) =>
      batch.scans.map((s) => ({
        clientScanId: s.clientScanId,
        result: 'ACCEPTED' as const,
        ticket,
      })),
    );
    expect(store.scans[0]!.status).toBe('SYNCED');
  });

  it('splits a long queue into batches and keeps what was already answered', async () => {
    const store = memoryStore();
    for (let i = 0; i < 450; i++) {
      await store.addScan({
        clientScanId: `s${i}`,
        eventId: EVENT,
        gateId: 'north',
        ticketId: `t${i}`,
        qr: TICKET_1,
        scannedAt: new Date(Date.UTC(2026, 11, 4, 10, 0, i)).toISOString(),
        status: 'QUEUED',
      });
    }
    const sizes: number[] = [];

    await expect(
      syncQueue(store, async (_, batch) => {
        sizes.push(batch.scans.length);
        if (sizes.length === 2) throw new TypeError('Failed to fetch');
        return batch.scans.map((s) => ({
          clientScanId: s.clientScanId,
          result: 'ACCEPTED' as const,
          ticket,
        }));
      }),
    ).rejects.toThrow();

    expect(sizes).toEqual([200, 200]);
    await expect(store.queuedScans()).resolves.toHaveLength(250);
  });

  it('sends different gates separately', async () => {
    const store = memoryStore();
    await scan(TICKET_1, store);
    await store.addScan({ ...store.scans[0]!, clientScanId: 'other', gateId: 'south' });
    const gates: string[] = [];

    await syncQueue(store, async (_, batch) => {
      gates.push(batch.gateId);
      return [];
    });

    expect(gates).toEqual(['north', 'south']);
  });

  it('one ticket, two offline phones: the first to sync is accepted, the other flagged', async () => {
    const phoneA = memoryStore();
    const phoneB = memoryStore();
    await scan(TICKET_1, phoneA);
    await scan(TICKET_1, phoneB);
    // A stand-in for the server's guarded UPDATE: the first scan of a ticket wins.
    const checkedIn = new Set<string>();
    const server = async (_: string, batch: { scans: { clientScanId: string; qr: string }[] }) =>
      batch.scans.map((s) => {
        if (checkedIn.has(s.qr)) {
          return {
            clientScanId: s.clientScanId,
            result: 'DUPLICATE' as const,
            ticketId: TICKET_ID_1,
            firstScannedAt: '2026-12-04T10:00:00Z',
            firstScannedBy: null,
          };
        }
        checkedIn.add(s.qr);
        return { clientScanId: s.clientScanId, result: 'ACCEPTED' as const, ticket };
      });

    await syncQueue(phoneB, server);
    await syncQueue(phoneA, server);

    expect(phoneB.scans[0]!.status).toBe('SYNCED');
    expect(phoneA.scans[0]!.status).toBe('CONFLICT');
  });
});
