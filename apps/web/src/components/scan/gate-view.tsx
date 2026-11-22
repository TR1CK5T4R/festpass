'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/dates';
import type { SavedGate } from '@/lib/scan/store';
import { useGate, type GateResult } from '@/lib/scan/use-gate';
import { Camera } from './camera';

const panelTones: Record<GateResult['tone'], string> = {
  accepted: 'bg-success text-white',
  duplicate: 'bg-warning text-white',
  invalid: 'bg-danger text-white',
};

export function GateView({
  gate,
  deviceId,
  onChangeGate,
}: {
  gate: SavedGate;
  deviceId: string;
  onChangeGate: () => void;
}) {
  const auth = useAuth();
  const { reachable, manifestInfo, queued, flagged, result, syncProblem, handleScan } = useGate(
    gate,
    deviceId,
  );
  const [typed, setTyped] = useState('');

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const qr = typed.trim();
    if (!qr) return;
    setTyped('');
    void handleScan(qr);
  };

  return (
    <>
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{gate.eventTitle}</h1>
          <p className="text-sm text-muted">Gate: {gate.gateId}</p>
        </div>
        <Badge tone={reachable ? 'success' : 'warning'}>{reachable ? 'Online' : 'Offline'}</Badge>
      </header>

      {/* The words carry the meaning too, so nobody has to rely on telling the colours apart. */}
      <div
        role="status"
        aria-live="assertive"
        data-testid="scan-result"
        className={`rounded-card p-5 text-center ${result ? panelTones[result.tone] : 'border border-dashed border-line text-muted'}`}
      >
        <p className="text-2xl font-bold">{result?.title ?? 'Ready to scan'}</p>
        {result && <p className="mt-1 text-sm">{result.detail}</p>}
      </div>

      <Camera onScan={handleScan} />

      <form onSubmit={submitTyped} className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Camera trouble? Paste the code"
            value={typed}
            placeholder="FP1…"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          Check
        </Button>
      </form>

      {!reachable && (
        <p className="rounded-card bg-warning/10 p-3 text-sm text-warning">
          Offline: scans are checked on this phone and synced when the network is back. Another
          phone may let the same ticket in; that shows up below after syncing.
        </p>
      )}
      {auth.status === 'anonymous' && !auth.unreachable && (
        <p className="rounded-card bg-warning/10 p-3 text-sm text-warning">
          Your session ended. Scans are saved on this phone.{' '}
          <Link href="/login?next=/scan" className="font-medium underline">
            Log in to sync
          </Link>
        </p>
      )}
      {syncProblem && <p className="text-sm text-danger">Sync failed: {syncProblem}</p>}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-card border border-line bg-surface p-3">
          <dt className="text-muted">Waiting to sync</dt>
          <dd data-testid="queued-count" className="text-xl font-semibold">
            {queued}
          </dd>
        </div>
        <div className="rounded-card border border-line bg-surface p-3">
          <dt className="text-muted">Ticket list</dt>
          <dd data-testid="manifest-info" className="font-medium">
            {manifestInfo
              ? `${manifestInfo.count} tickets, ${formatDateTime(manifestInfo.at)}`
              : 'Not downloaded: replaced QRs can’t be caught offline'}
          </dd>
        </div>
      </dl>

      {flagged.length > 0 && (
        <section aria-labelledby="flagged-heading">
          <h2 id="flagged-heading" className="mb-2 font-semibold">
            Needs a look ({flagged.length})
          </h2>
          <ul data-testid="flagged-list" className="flex flex-col gap-2">
            {flagged.map((scan) => (
              <li
                key={scan.clientScanId}
                className="rounded-card border border-warning/30 bg-surface p-3 text-sm"
              >
                <p className="font-medium">
                  Ticket {scan.ticketId.slice(0, 8)} let in here at {formatDateTime(scan.scannedAt)}
                </p>
                <p className="text-muted">
                  {scan.status === 'CONFLICT'
                    ? `Scanned elsewhere first: ${scan.firstScannedAt ? formatDateTime(scan.firstScannedAt) : 'earlier'} by ${scan.firstScannedBy ?? 'someone'}`
                    : scan.message}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="rounded-card border border-line bg-surface p-3 text-sm">
        <summary className="cursor-pointer font-medium">What can offline mode promise?</summary>
        <p className="mt-2 font-medium">It can promise the ticket:</p>
        <ul className="ml-5 list-disc text-muted">
          <li>is genuine and for this event (the signature is checked on this phone)</li>
          <li>has not been scanned on this phone</li>
          <li>was not replaced or used as of the last ticket list download</li>
        </ul>
        <p className="mt-2 font-medium">It cannot promise:</p>
        <ul className="ml-5 list-disc text-muted">
          <li>that another offline phone hasn’t let the same ticket in</li>
          <li>anything that changed after the last ticket list download</li>
        </ul>
        <p className="mt-2 text-muted">
          When phones sync, the first scan to reach the server wins. The others are listed here for
          a person to follow up.
        </p>
      </details>

      <Button variant="ghost" onClick={onChangeGate} disabled={!reachable}>
        Change event or gate
      </Button>
    </>
  );
}
