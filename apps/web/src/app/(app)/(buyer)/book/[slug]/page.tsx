'use client';

import {
  ADMISSION_HEADER,
  formatPaise,
  type OrderView,
  type PublicEventView,
  type QueueStatus,
} from '@festpass/shared';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api, isApiError } from '@/lib/api';
import { bookingKey } from '@/lib/booking';
import { formatDateTime, formatTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';

/** Choose how many tickets of one tier, then hold them: POST /events/:id/orders. */
export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const tierId = useSearchParams().get('tier');
  const router = useRouter();
  const { data, error } = useApiData<{ event: PublicEventView }>(`/events/${slug}`);
  const [qty, setQty] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Null until a queue-mode event's status is known; events without a queue never need it.
  const [admission, setAdmission] = useState<QueueStatus | null>(null);
  const eventId = data?.event.id;
  const queueMode = data?.event.queueMode;
  const queuePath = `/queue/${slug}?tier=${tierId}`;

  useEffect(() => {
    if (!queueMode) return;
    api.request<QueueStatus>(`/events/${eventId}/queue/status`).then(
      (status) => {
        if (status.state === 'admitted' || status.state === 'not_required') setAdmission(status);
        else router.replace(queuePath);
      },
      // Sale ended, API down: let the page show. Booking answers with the real reason.
      () => setAdmission({ state: 'not_required' }),
    );
  }, [queueMode, eventId, queuePath, router]);

  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!data || (data.event.queueMode && !admission)) {
    return <p className="text-sm text-muted">Loading…</p>;
  }
  const { event } = data;
  const tier = event.tiers.find((t) => t.id === tierId);
  if (!tier) {
    return (
      <p className="text-sm text-muted">
        That ticket type isn&apos;t available.{' '}
        <Link href={`/e/${slug}`} className="underline">
          Back to the event
        </Link>
      </p>
    );
  }
  const max = Math.max(1, Math.min(tier.perUserLimit, tier.available, 10));

  async function reserve() {
    setSubmitting(true);
    setFailure(null);
    try {
      // The same key for every retry of this attempt (double click, timeout, reload): the API then
      // returns the order it already made instead of holding a second set of tickets.
      const key = bookingKey(slug, tier!.id, qty);
      const { order } = await api.request<{ order: OrderView }>(`/events/${event.id}/orders`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': key,
          ...(admission?.state === 'admitted' && { [ADMISSION_HEADER]: admission.token }),
        },
        body: { items: [{ tierId: tier!.id, qty }] },
      });
      router.replace(`/checkout/${order.id}`);
    } catch (err) {
      // The token ran out while choosing, or queue mode was just turned on.
      if (isApiError(err, 'ADMISSION_REQUIRED')) return router.replace(queuePath);
      setFailure(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-brand-600">{event.org.name}</p>
        <h1 className="text-xl font-semibold">{event.title}</h1>
        <p className="text-sm text-muted">
          {event.venue} · {formatDateTime(event.startsAt)}
        </p>
      </div>
      <div className="flex items-end justify-between gap-4 rounded-control border border-line p-4">
        <div>
          <p className="font-medium">{tier.name}</p>
          <p className="text-sm text-muted">
            {formatPaise(tier.pricePaise)} each · {tier.available} left
          </p>
        </div>
        <Select
          label="Tickets"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-24"
        >
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <p className="flex justify-between text-sm">
        <span className="text-muted">Total</span>
        <span className="text-lg font-semibold">{formatPaise(tier.pricePaise * qty)}</span>
      </p>
      {failure && (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
      <Button onClick={() => void reserve()} loading={submitting} disabled={tier.available === 0}>
        {failure ? 'Try again' : 'Hold my tickets'}
      </Button>
      {admission?.state === 'admitted' && (
        <p className="text-sm text-muted">
          You&apos;re in. Book by {formatTime(admission.expiresAt)} to keep your place.
        </p>
      )}
      <p className="text-xs text-muted">
        Your tickets are held for a few minutes while you pay. Unpaid holds are released
        automatically.
      </p>
    </Card>
  );
}
