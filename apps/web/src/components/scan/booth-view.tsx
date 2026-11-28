'use client';

import type { BoothVisit } from '@festpass/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, isApiError } from '@/lib/api';
import { errorMessage } from '@/lib/form-errors';
import type { SavedGate } from '@/lib/scan/store';
import { Camera } from './camera';

const SCAN_TIMEOUT_MS = 4_000;

interface Result {
  tone: 'accepted' | 'invalid';
  title: string;
  detail: string;
}

const panelTones: Record<Result['tone'], string> = {
  accepted: 'bg-success text-white',
  invalid: 'bg-danger text-white',
};

/**
 * Booth mode: the same scanner, counting visits to a sponsor's booth. Online only: a visit decides
 * nothing (the gate already let the person in), so there is nothing worth checking offline, and a
 * visit that can't be sent is simply not counted. The screen never shows who the visitor is.
 */
export function BoothView({
  gate,
  deviceId,
  onChangeGate,
}: {
  gate: SavedGate & { booth: NonNullable<SavedGate['booth']> };
  deviceId: string;
  onChangeGate: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [visits, setVisits] = useState(0);
  const [typed, setTyped] = useState('');
  const busy = useRef(false);

  async function handleScan(qr: string) {
    if (busy.current) return;
    busy.current = true;
    try {
      const { visit } = await Promise.race([
        api.request<{ visit: BoothVisit }>(`/booths/${gate.booth.id}/scans`, {
          method: 'POST',
          body: { qr, deviceId, clientScanId: crypto.randomUUID() },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), SCAN_TIMEOUT_MS),
        ),
      ]);
      setVisits((n) => n + 1);
      setResult({ tone: 'accepted', title: 'Visit recorded', detail: visit.tierName });
      navigator.vibrate?.(100);
    } catch (err) {
      const offline = !isApiError(err) || err.status >= 500;
      setResult({
        tone: 'invalid',
        title: offline
          ? 'No connection'
          : err.code === 'NOT_CHECKED_IN'
            ? 'Not checked in'
            : 'Not counted',
        detail: offline
          ? 'Booth scans need the network. Try again in a moment.'
          : errorMessage(err),
      });
      navigator.vibrate?.(400);
    } finally {
      busy.current = false;
    }
  }

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 4_000);
    return () => clearTimeout(timer);
  }, [result]);

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
          <p className="text-sm text-muted">
            Booth: {gate.booth.name} · {gate.booth.sponsorName}
          </p>
        </div>
        <Badge tone="brand">Booth mode</Badge>
      </header>

      <div
        role="status"
        aria-live="assertive"
        data-testid="scan-result"
        className={`rounded-card p-5 text-center ${result ? panelTones[result.tone] : 'border border-dashed border-line text-muted'}`}
      >
        <p className="text-2xl font-bold">{result?.title ?? 'Ready to scan'}</p>
        {result && <p className="mt-1 text-sm">{result.detail}</p>}
      </div>

      <Camera onScan={(qr) => void handleScan(qr)} />

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

      <p className="text-sm text-muted">
        Visits recorded on this phone:{' '}
        <span data-testid="visit-count" className="font-semibold text-ink">
          {visits}
        </span>
        . Each scan counts as a visit; the sponsor sees totals only, never names.
      </p>

      <Button variant="ghost" onClick={onChangeGate}>
        Change event, gate or booth
      </Button>
    </>
  );
}
