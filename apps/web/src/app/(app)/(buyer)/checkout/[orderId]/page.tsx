'use client';

import { formatPaise, type OrderDetails, type PaymentView } from '@festpass/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { forgetBookingKeys } from '@/lib/booking';
import { formatDateTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { openCheckout } from '@/lib/razorpay';
import { useApiData } from '@/lib/use-api-data';

// How long to keep asking after the browser says "paid" before telling the buyer it's taking a while.
const CONFIRM_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 2000;

type Phase = 'ready' | 'paying' | 'confirming' | 'slow';

export default function CheckoutPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data, error, reload } = useApiData<OrderDetails>(`/orders/${orderId}`);
  const [phase, setPhase] = useState<Phase>('ready');
  const [failure, setFailure] = useState<string | null>(null);
  const secondsLeft = useSecondsUntil(data?.order.expiresAt);

  // While confirming, ask the API for the order every 2 s. Only the API (after Razorpay's webhook)
  // can say the payment really happened; what the browser said is just why we started asking.
  useEffect(() => {
    if (phase !== 'confirming') return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > CONFIRM_TIMEOUT_MS) setPhase('slow');
      else reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase, reload]);

  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!data) return <p className="text-sm text-muted">Loading your order…</p>;
  const { order, event } = data;
  const expired = order.status === 'EXPIRED' || (order.status === 'PENDING' && secondsLeft === 0);

  async function pay() {
    setFailure(null);
    setPhase('paying');
    try {
      const { payment } = await api.request<{ payment: PaymentView }>(`/orders/${orderId}/pay`, {
        method: 'POST',
      });
      await openCheckout(payment, {
        onSuccess: () => setPhase('confirming'),
        onDismiss: () => setPhase('ready'),
      });
    } catch (err) {
      setFailure(errorMessage(err));
      setPhase('ready');
    }
  }

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{event.title}</h1>
          <p className="text-sm text-muted">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
        </div>
        <Badge tone={order.status === 'PENDING' ? 'warning' : 'neutral'}>{order.status}</Badge>
      </div>

      <ul className="divide-y divide-line rounded-control border border-line">
        {order.items.map((item) => (
          <li key={item.tierId} className="flex justify-between px-4 py-3 text-sm">
            <span>
              {item.qty} × {item.tierName}
            </span>
            <span>{formatPaise(item.qty * item.unitPricePaise)}</span>
          </li>
        ))}
        <li className="flex justify-between px-4 py-3 font-semibold">
          <span>Total</span>
          <span>{formatPaise(order.amountPaise)}</span>
        </li>
      </ul>

      {order.status === 'TICKETED' || order.status === 'PAID' ? (
        <p role="status" className="rounded-control bg-success/10 px-4 py-3 text-sm text-success">
          Payment confirmed.{' '}
          {order.status === 'TICKETED'
            ? 'Your tickets are ready.'
            : 'Your tickets are being issued.'}
        </p>
      ) : expired ? (
        <div className="flex flex-col gap-3 rounded-control bg-canvas px-4 py-4 text-sm">
          <p>Your hold has ended and the tickets went back on sale. You weren&apos;t charged.</p>
          <Link
            href={`/e/${event.slug}`}
            onClick={() => forgetBookingKeys(event.slug)}
            className="self-start font-medium text-brand-600 hover:underline"
          >
            Book again
          </Link>
        </div>
      ) : order.status !== 'PENDING' ? (
        <p className="text-sm text-muted">
          This order is {order.status.toLowerCase()} and can&apos;t be paid.
        </p>
      ) : phase === 'confirming' || phase === 'slow' ? (
        <p role="status" className="rounded-control bg-brand-50 px-4 py-3 text-sm text-brand-700">
          {phase === 'confirming'
            ? 'Confirming payment… This page updates by itself.'
            : 'Razorpay is still confirming your payment. Keep this page open or check back soon; if it went through, your tickets will appear.'}
        </p>
      ) : (
        <>
          <p className="text-sm" role="timer" aria-live="off">
            Tickets held for{' '}
            <strong className="tabular-nums">{formatCountdown(secondsLeft ?? 0)}</strong>
          </p>
          {failure && (
            <p role="alert" className="text-sm text-danger">
              {failure}
            </p>
          )}
          <Button onClick={() => void pay()} loading={phase === 'paying'}>
            Pay {formatPaise(order.amountPaise)}
          </Button>
          <p className="text-xs text-muted">
            Payments run in Razorpay test mode: use a Razorpay test card or UPI ID, never a real
            one.
          </p>
        </>
      )}
    </Card>
  );
}

/** Seconds until `iso`, ticking every second; 0 once it has passed, undefined until known. */
function useSecondsUntil(iso: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!iso) return undefined;
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
}

const formatCountdown = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
