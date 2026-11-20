'use client';

import type { TicketView } from '@festpass/shared';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';

/** My Tickets: every ticket with its QR, grouped by order, and the order's PDF. */
export default function MyTicketsPage() {
  const { data, error } = useApiData<{ tickets: TicketView[] }>('/me/tickets');

  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!data) return <p className="text-sm text-muted">Loading your tickets…</p>;
  if (data.tickets.length === 0) {
    return (
      <EmptyState
        title="No tickets yet"
        description="Tickets you buy show up here as soon as the payment is confirmed."
        action={
          <Link href="/" className="text-sm font-medium text-brand-600 hover:underline">
            Find an event
          </Link>
        }
      />
    );
  }

  const orders = new Map<string, TicketView[]>();
  for (const ticket of data.tickets) {
    orders.set(ticket.orderId, [...(orders.get(ticket.orderId) ?? []), ticket]);
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">My tickets</h1>
      {[...orders.entries()].map(([orderId, tickets]) => (
        <OrderTickets key={orderId} orderId={orderId} tickets={tickets} />
      ))}
    </div>
  );
}

function OrderTickets({ orderId, tickets }: { orderId: string; tickets: TicketView[] }) {
  const event = tickets[0]!.event;
  const [downloading, setDownloading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Asks for a new 5-minute link on every click: the PDF is private, and an old link may have expired.
  async function download() {
    setDownloading(true);
    setFailure(null);
    try {
      const { pdf } = await api.request<{ pdf: { url: string } }>(`/orders/${orderId}/tickets-pdf`);
      window.location.assign(pdf.url);
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{event.title}</h2>
          <p className="text-sm text-muted">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void download()} loading={downloading}>
          Download PDF
        </Button>
      </div>
      {failure && (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
      <ul className="grid gap-4 sm:grid-cols-2">
        {tickets.map((ticket) => (
          <li
            key={ticket.id}
            className="flex flex-col items-center gap-2 rounded-control border border-line p-4"
          >
            <QrImage value={ticket.qr} label={`QR code for ticket ${ticket.code}`} />
            <p className="font-mono text-lg tracking-widest">{ticket.code}</p>
            <p className="text-sm text-muted">
              {ticket.tier.name} · ticket {ticket.seq}
            </p>
            {ticket.checkedInAt && <Badge>Used {formatDateTime(ticket.checkedInAt)}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Draws the signed QR string in the browser: the server only ever sends the text. */
function QrImage({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: 240 }).then(
      (url) => active && setSrc(url),
    );
    return () => {
      active = false;
    };
  }, [value]);
  if (!src) return <div className="size-[200px] animate-pulse rounded bg-line" />;
  // eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn in the browser
  return <img src={src} alt={label} width={200} height={200} />;
}
