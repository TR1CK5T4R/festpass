import type { GateManifest } from '@festpass/shared';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ScanStore, StoredScan } from './offline';

/** The gate this phone is working: chosen once online, remembered for offline reloads. */
export interface SavedGate {
  eventId: string;
  eventTitle: string;
  gateId: string;
  /** Set in booth mode: this phone counts visits to a sponsor's booth instead of letting people in. */
  booth?: { id: string; name: string; sponsorName: string };
}

interface ScannerDb extends DBSchema {
  manifests: { key: string; value: GateManifest };
  scans: {
    key: string;
    value: StoredScan;
    indexes: { 'by-ticket': [string, string]; 'by-status': string };
  };
  settings: { key: string; value: unknown };
}

let db: Promise<IDBPDatabase<ScannerDb>> | null = null;

// Opened on first use: this module also loads during server rendering, where IndexedDB doesn't exist.
function open() {
  db ??= openDB<ScannerDb>('festpass-scanner', 1, {
    upgrade(database) {
      database.createObjectStore('manifests', { keyPath: 'eventId' });
      database.createObjectStore('settings');
      const scans = database.createObjectStore('scans', { keyPath: 'clientScanId' });
      scans.createIndex('by-ticket', ['eventId', 'ticketId']);
      scans.createIndex('by-status', 'status');
    },
  });
  return db;
}

// shortcut: synced scans are never deleted (about 2 MB per 5,000 scans); prune them after the event if
// phones ever run short. They are what stops a second scan on this device, so never during one.
export const scanStore: ScanStore = {
  async scansOfTicket(eventId, ticketId) {
    return (await open()).getAllFromIndex('scans', 'by-ticket', [eventId, ticketId]);
  },
  async addScan(scan) {
    await (await open()).put('scans', scan);
  },
  async queuedScans() {
    const scans = await (await open()).getAllFromIndex('scans', 'by-status', 'QUEUED');
    return scans.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
  },
  async updateScan(clientScanId, changes) {
    const database = await open();
    const scan = await database.get('scans', clientScanId);
    if (scan) await database.put('scans', { ...scan, ...changes });
  },
};

export async function countQueued() {
  return (await open()).countFromIndex('scans', 'by-status', 'QUEUED');
}

/** Scans the server disagreed with, newest first: conflicts and rejections, for a person to look at. */
export async function flaggedScans(eventId: string) {
  const database = await open();
  const flagged = [
    ...(await database.getAllFromIndex('scans', 'by-status', 'CONFLICT')),
    ...(await database.getAllFromIndex('scans', 'by-status', 'REJECTED')),
  ];
  return flagged
    .filter((s) => s.eventId === eventId)
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

export async function saveManifest(manifest: GateManifest) {
  await (await open()).put('manifests', manifest);
}

export async function loadManifest(eventId: string) {
  return (await open()).get('manifests', eventId);
}

export async function saveGate(gate: SavedGate | null) {
  await (await open()).put('settings', gate, 'gate');
}

/** The saved gate, and this phone's ID (made on first use; sent with scans so reports can tell phones apart). */
export async function loadGateSettings() {
  const database = await open();
  let deviceId = (await database.get('settings', 'deviceId')) as string | undefined;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await database.put('settings', deviceId, 'deviceId');
  }
  const gate = ((await database.get('settings', 'gate')) as SavedGate | null | undefined) ?? null;
  return { gate, deviceId };
}
