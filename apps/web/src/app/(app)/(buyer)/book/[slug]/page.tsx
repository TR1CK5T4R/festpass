'use client';

import { formatPaise, type OrderView, type PublicEventView } from '@festpass/shared';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { bookingKey } from '@/lib/booking';
import { formatDateTime } from '@/lib/dates';
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

  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
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
        headers: { 'Idempotency-Key': key },
        body: { items: [{ tierId: tier!.id, qty }] },
      });
      router.replace(`/checkout/${order.id}`);
    } catch (err) {
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
      <p className="text-xs text-muted">
        Your tickets are held for a few minutes while you pay. Unpaid holds are released
        automatically.
      </p>
    </Card>
  );
}
