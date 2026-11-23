'use client';

import type { CheckinSummary, LiveScan } from '@festpass/shared';
import { useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { useApiData } from '@/lib/use-api-data';
import { useEventSocket, type SocketStatus } from '@/lib/use-event-socket';

const FEED_LENGTH = 20;
const session = { token: api.accessToken, refresh: api.refresh };

const statusBadge: Record<SocketStatus, { tone: 'success' | 'warning' | 'neutral'; text: string }> =
  {
    connecting: { tone: 'neutral', text: 'Connecting…' },
    live: { tone: 'success', text: 'Live' },
    reconnecting: { tone: 'warning', text: 'Reconnecting…' },
    denied: { tone: 'warning', text: 'Not live: reload the page' },
  };

const resultTone = { ACCEPTED: 'success', DUPLICATE: 'warning' } as const;

/** Entry at the gate as it happens: a counter from Postgres, then each scan as it arrives. */
export function LiveCheckins({ eventId }: { eventId: string }) {
  const path = `/events/${eventId}/checkins/summary`;
  const { data, reload, setData } = useApiData<{ summary: CheckinSummary }>(path);
  const joinedBefore = useRef(false);

  const status = useEventSocket({
    eventId,
    room: 'staff',
    session,
    onJoined: () => {
      // Scans made while the connection was down never arrive, so ask again after a reconnect.
      if (joinedBefore.current) reload();
      joinedBefore.current = true;
    },
    onScan: (scan) => {
      if (!data) return;
      const { summary } = data;
      setData({
        summary: {
          ...summary,
          checkedIn: summary.checkedIn + (scan.result === 'ACCEPTED' ? 1 : 0),
          recent: [scan, ...summary.recent].slice(0, FEED_LENGTH),
        },
      });
    },
  });
  const badge = statusBadge[status];

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Check-ins</h2>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      {!data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          <p data-testid="checkin-count" className="text-3xl font-bold">
            {data.summary.checkedIn}
            <span className="text-lg font-medium text-muted">
              {' '}
              / {data.summary.totalTickets} tickets
            </span>
          </p>
          {data.summary.recent.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No scans yet.</p>
          ) : (
            <ul data-testid="scan-feed" className="mt-4 flex flex-col divide-y divide-line">
              {data.summary.recent.map((scan, i) => (
                <ScanRow key={`${scan.ts}-${scan.ticketId}-${i}`} scan={scan} />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ScanRow({ scan }: { scan: LiveScan }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <Badge
        tone={
          scan.result === 'ACCEPTED' || scan.result === 'DUPLICATE'
            ? resultTone[scan.result]
            : 'neutral'
        }
      >
        {scan.result}
      </Badge>
      <span>{scan.tierName ?? 'Unknown ticket'}</span>
      {scan.ticketId && <span className="text-muted">{scan.ticketId.slice(0, 8)}</span>}
      <span className="text-muted">
        {scan.gateId}
        {scan.offline && ' (synced from offline)'}
      </span>
      <span className="ml-auto text-muted">{formatDateTime(scan.ts)}</span>
    </li>
  );
}
