'use client';

import {
  verifyTicket,
  type BatchScanResult,
  type CheckedInTicket,
  type GateManifest,
} from '@festpass/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isApiError } from '../api';
import { formatDateTime } from '../dates';
import { errorMessage } from '../form-errors';
import {
  indexManifest,
  scanOffline,
  scannedOnThisDevice,
  syncQueue,
  type ManifestIndex,
  type StoredScan,
} from './offline';
import {
  countQueued,
  flaggedScans,
  loadManifest,
  saveManifest,
  scanStore,
  type SavedGate,
} from './store';

const PUBLIC_KEY = process.env.NEXT_PUBLIC_TICKET_PUBLIC_KEY ?? '';
const MANIFEST_REFRESH_MS = 5 * 60_000;
const SYNC_EVERY_MS = 30_000;
// A venue's network often hangs rather than fails. A person is waiting, so a scan gives up quickly.
const SCAN_TIMEOUT_MS = 4_000;
const SYNC_TIMEOUT_MS = 30_000;

export interface GateResult {
  tone: 'accepted' | 'duplicate' | 'invalid';
  title: string;
  detail: string;
}

function withTimeout<T>(request: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), ms)),
  ]);
}

const shortId = (ticketId: string) => ticketId.slice(0, 8);

function buzz(tone: GateResult['tone']) {
  const pattern = { accepted: 100, duplicate: [100, 80, 100], invalid: 400 }[tone];
  navigator.vibrate?.(pattern);
}

/** Everything a gate does: scan, queue, download the ticket list, sync. The UI only shows the state. */
export function useGate(gate: SavedGate, deviceId: string) {
  const { eventId, gateId } = gate;
  const [reachable, setReachableState] = useState(true);
  const [manifestInfo, setManifestInfo] = useState<{ count: number; at: string } | null>(null);
  const [queued, setQueued] = useState(0);
  const [flagged, setFlagged] = useState<StoredScan[]>([]);
  const [result, setResult] = useState<GateResult | null>(null);
  const [syncProblem, setSyncProblem] = useState<string | null>(null);

  // Read by timers and the camera callback, which must always see the latest value.
  const reachableRef = useRef(true);
  const manifestRef = useRef<ManifestIndex | null>(null);
  const manifestFetchedAt = useRef(0);
  const handling = useRef(false);
  const ticking = useRef(false);

  const setReachable = useCallback((value: boolean) => {
    reachableRef.current = value;
    setReachableState(value);
  }, []);

  const applyManifest = useCallback((manifest: GateManifest) => {
    manifestRef.current = indexManifest(manifest);
    setManifestInfo({ count: manifest.tickets.length, at: manifest.generatedAt });
  }, []);

  const refreshCounts = useCallback(async () => {
    setQueued(await countQueued());
    setFlagged(await flaggedScans(eventId));
  }, [eventId]);

  /** Sync, and keep the ticket list fresh. Runs on a timer and on reconnect, one at a time. */
  const tick = useCallback(async () => {
    if (ticking.current) return;
    if (!navigator.onLine) {
      setReachable(false);
      return;
    }
    ticking.current = true;
    try {
      // A scan or sync may have failed earlier: check before trusting the network again.
      if (!reachableRef.current) await withTimeout(api.request('/health/live'), SCAN_TIMEOUT_MS);
      setReachable(true);
      await syncQueue(scanStore, async (scanEventId, batch) => {
        const { results } = await withTimeout(
          api.request<{ results: BatchScanResult[] }>(`/events/${scanEventId}/checkins/batch`, {
            method: 'POST',
            body: { deviceId, ...batch },
          }),
          SYNC_TIMEOUT_MS,
        );
        return results;
      });
      if (Date.now() - manifestFetchedAt.current >= MANIFEST_REFRESH_MS) {
        const { manifest } = await withTimeout(
          api.request<{ manifest: GateManifest }>(`/events/${eventId}/checkins/manifest`),
          SYNC_TIMEOUT_MS,
        );
        await saveManifest(manifest);
        applyManifest(manifest);
        manifestFetchedAt.current = Date.now();
      }
      setSyncProblem(null);
    } catch (err) {
      if (!isApiError(err) || err.status >= 500) setReachable(false);
      // A 401 is shown as "log in to sync", from the auth state. Anything else needs reading.
      else if (err.status !== 401) setSyncProblem(errorMessage(err));
    } finally {
      ticking.current = false;
      await refreshCounts();
    }
  }, [deviceId, eventId, refreshCounts, setReachable, applyManifest]);

  useEffect(() => {
    void (async () => {
      const saved = await loadManifest(eventId);
      if (saved) applyManifest(saved);
      await refreshCounts();
      await tick();
    })();
    const timer = setInterval(() => void tick(), SYNC_EVERY_MS);
    const onOnline = () => void tick();
    const onOffline = () => setReachable(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [applyManifest, eventId, refreshCounts, setReachable, tick]);

  const decideOnline = useCallback(
    async (qr: string, clientScanId: string, now: Date): Promise<GateResult | null> => {
      const record = (ticketId: string) =>
        scanStore.addScan({
          clientScanId,
          eventId,
          gateId,
          ticketId,
          qr,
          scannedAt: now.toISOString(),
          status: 'SYNCED',
        });
      try {
        const { ticket } = await withTimeout(
          api.request<{ ticket: CheckedInTicket }>(`/events/${eventId}/checkins`, {
            method: 'POST',
            body: { qr, deviceId, gateId, clientScanId },
          }),
          SCAN_TIMEOUT_MS,
        );
        await record(ticket.id); // so this phone still refuses it if the network dies a minute later
        return {
          tone: 'accepted',
          title: 'Accepted',
          detail: `${ticket.attendeeName}, ${ticket.tierName}`,
        };
      } catch (err) {
        // No answer, or no session: the gate keeps moving on what it can check itself. A timed-out scan
        // keeps its clientScanId, so if the server did get it, the sync won't look like a conflict.
        if (!isApiError(err) || err.status >= 500) {
          setReachable(false);
          return null;
        }
        if (err.status === 401) return null;
        if (err.code === 'ALREADY_CHECKED_IN') {
          const { ticketId, firstScannedAt, firstScannedBy } = err.details as {
            ticketId: string;
            firstScannedAt: string;
            firstScannedBy: { name: string } | null;
          };
          await record(ticketId);
          return {
            tone: 'duplicate',
            title: 'Already scanned',
            detail: `First scanned ${formatDateTime(firstScannedAt)} by ${firstScannedBy?.name ?? 'someone'}`,
          };
        }
        return {
          tone: 'invalid',
          title: err.code === 'QR_REVOKED' ? 'Revoked' : 'Invalid',
          detail: errorMessage(err),
        };
      }
    },
    [deviceId, eventId, gateId, setReachable],
  );

  const decideOffline = useCallback(
    async (qr: string, clientScanId: string, now: Date): Promise<GateResult> => {
      const verdict = await scanOffline(qr, {
        store: scanStore,
        publicKey: PUBLIC_KEY,
        eventId,
        gateId,
        manifest: manifestRef.current,
        clientScanId,
        now,
      });
      switch (verdict.result) {
        case 'ACCEPTED':
          return {
            tone: 'accepted',
            title: 'Accepted (offline)',
            detail: `Ticket ${shortId(verdict.ticketId)}: genuine, queued to sync`,
          };
        case 'DUPLICATE':
          return {
            tone: 'duplicate',
            title: 'Already scanned',
            detail: `Ticket ${shortId(verdict.ticketId)} is already marked as used`,
          };
        case 'REVOKED':
          return { tone: 'invalid', title: 'Revoked', detail: verdict.message };
        default:
          return { tone: 'invalid', title: 'Invalid', detail: verdict.message };
      }
    },
    [eventId, gateId],
  );

  const handleScan = useCallback(
    async (qr: string) => {
      if (handling.current) return; // the camera will read the next code again in a moment
      handling.current = true;
      try {
        const now = new Date();
        const clientScanId = crypto.randomUUID();
        let decision: GateResult | null = null;

        // Checked first even when online: this phone may hold a queued scan of this ticket that the
        // server hasn't heard about, and it would happily accept the ticket a second time.
        const verified = await verifyTicket(qr, PUBLIC_KEY);
        const previous =
          verified.valid && verified.payload.e === eventId
            ? await scannedOnThisDevice(scanStore, eventId, verified.payload.t)
            : null;
        if (previous) {
          decision = {
            tone: 'duplicate',
            title: 'Already scanned',
            detail: `Scanned on this phone at ${formatDateTime(previous.scannedAt)}`,
          };
        } else if (reachableRef.current && navigator.onLine) {
          decision = await decideOnline(qr, clientScanId, now);
        }
        decision ??= await decideOffline(qr, clientScanId, now);

        setResult(decision);
        buzz(decision.tone);
        await refreshCounts();
      } finally {
        handling.current = false;
      }
    },
    [decideOffline, decideOnline, eventId, refreshCounts],
  );

  // A panel that stays green would make the next person look already approved.
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 5_000);
    return () => clearTimeout(timer);
  }, [result]);

  return { reachable, manifestInfo, queued, flagged, result, syncProblem, handleScan };
}
