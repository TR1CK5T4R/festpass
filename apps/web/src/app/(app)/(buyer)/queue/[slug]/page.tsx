'use client';

import type { PublicEventView, QueueStatus } from '@festpass/shared';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { api, isApiError } from '@/lib/api';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';
import { useEventSocket } from '@/lib/use-event-socket';
import { formatWait, pollDelayMs } from '@/lib/waiting-room';

const session = { token: api.accessToken, refresh: api.refresh };

const canBook = (status: QueueStatus | null) =>
  status?.state === 'admitted' || status?.state === 'not_required';

/**
 * The waiting room. Everything shown comes from the server, so a reload lands back in the same place.
 * Nothing is stored in the browser: the booking page asks for the admission token itself.
 */
export default function QueuePage() {
  const { slug } = useParams<{ slug: string }>();
  const tierId = useSearchParams().get('tier');
  const router = useRouter();
  const { data, error } = useApiData<{ event: PublicEventView }>(`/events/${slug}`);
  const eventId = data?.event.id ?? null;
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [ended, setEnded] = useState<string | null>(null);

  /** Returns the new status, null for a passing failure, or 'ended'. Joins only if not already in line. */
  const check = useCallback(async () => {
    try {
      const path = `/events/${eventId}/queue`;
      let next = await api.request<QueueStatus>(`${path}/status`);
      if (next.state === 'not_joined') {
        next = await api.request<QueueStatus>(`${path}/join`, { method: 'POST' });
      }
      setStatus(next);
      return next;
    } catch (err) {
      // Busy or unreachable passes, so keep the last position and ask again. Anything else (sale ended,
      // event closed) won't change by waiting.
      if (isApiError(err) && err.status < 500 && err.status !== 429) {
        setEnded(errorMessage(err));
        return 'ended' as const;
      }
      return null;
    }
  }, [eventId]);

  useEffect(() => {
    if (!eventId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      const next = await check();
      if (stopped || next === 'ended' || canBook(next)) return;
      timer = setTimeout(() => void tick(), pollDelayMs(next));
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [eventId, check]);

  useEventSocket({
    eventId,
    room: 'public',
    session,
    onQueueAdmitted: () => void check(),
  });

  useEffect(() => {
    if (canBook(status)) {
      router.replace(tierId ? `/book/${slug}?tier=${tierId}` : `/e/${slug}`);
    }
  }, [status, router, slug, tierId]);

  const problem = error ? errorMessage(error) : ended;
  if (problem) {
    return (
      <p role="alert" className="text-sm text-danger">
        {problem}{' '}
        <Link href={`/e/${slug}`} className="underline">
          Back to the event
        </Link>
      </p>
    );
  }
  if (status?.state !== 'waiting') {
    return (
      <p role="status" className="text-sm text-muted">
        {canBook(status) ? 'It’s your turn. Taking you to booking…' : 'Finding your place in line…'}
      </p>
    );
  }

  return (
    <Card className="flex flex-col items-center gap-4 text-center">
      <div>
        <p className="text-sm text-brand-600">{data?.event.org.name}</p>
        <h1 className="text-xl font-semibold">{data?.event.title}</h1>
      </div>
      <div role="status" aria-live="polite">
        <p className="text-sm text-muted">Your place in line</p>
        <p className="text-5xl font-bold tabular-nums" data-testid="queue-position">
          {status.position.toLocaleString('en-IN')}
        </p>
        <p className="mt-2 text-sm text-muted">
          Estimated wait: {formatWait(status.estimatedWaitSeconds)}
        </p>
      </div>
      <p className="text-xs text-muted">
        You&apos;ll go to booking automatically when it&apos;s your turn, and then have 5 minutes to
        book. Reloading this page won&apos;t lose your place.
      </p>
    </Card>
  );
}
