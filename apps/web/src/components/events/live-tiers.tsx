'use client';

import { formatPaise, type PublicEventView, type TierView } from '@festpass/shared';
import Link from 'next/link';
import { useState } from 'react';
import { formatEventTime } from '@/lib/dates';
import { tierState } from '@/lib/tier-state';
import { useEventSocket } from '@/lib/use-event-socket';

/**
 * The tier cards as server-rendered, kept current over a socket. Without a connection (or JavaScript) the
 * page still shows the cached numbers, and booking always checks live stock anyway.
 */
export function LiveTiers({ event, renderedAt }: { event: PublicEventView; renderedAt: string }) {
  const [live, setLive] = useState<Record<string, number>>({});
  const status = useEventSocket({
    // A closed event's numbers no longer mean anything to a visitor.
    eventId: event.status === 'CLOSED' ? null : event.id,
    room: 'public',
    onAvailability: (update) =>
      setLive(Object.fromEntries(update.tiers.map((t) => [t.id, t.available]))),
  });
  const now = new Date(renderedAt);

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2">
        {event.tiers.map((tier) => (
          <li key={tier.id}>
            <TierCard
              tier={{ ...tier, available: live[tier.id] ?? tier.available }}
              event={event}
              now={now}
            />
          </li>
        ))}
      </ul>
      {/* The design rule for cached pages: availability here is a hint, never a promise. */}
      <p className="mt-4 text-xs text-muted">
        {status === 'live'
          ? 'Availability on this page updates live.'
          : 'Availability on this page is refreshed at least once a minute.'}{' '}
        Every booking is checked against live stock, so you are never sold a ticket that is already
        gone.
      </p>
    </>
  );
}

function TierCard({ tier, event, now }: { tier: TierView; event: PublicEventView; now: Date }) {
  const state = tierState(tier, event, now);
  const note = {
    'on-sale': `${tier.available} left · up to ${tier.perUserLimit} per person`,
    'not-yet': `On sale from ${state.kind === 'not-yet' ? formatEventTime(state.opensAt) : ''}`,
    ended: 'Sales for this ticket have ended',
    'sold-out': 'Sold out',
    closed: 'Booking is closed',
  }[state.kind];

  return (
    <div className="flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{tier.name}</h3>
        <p className="text-lg font-semibold">
          {tier.pricePaise === 0 ? 'Free' : formatPaise(tier.pricePaise)}
        </p>
      </div>
      <p className="text-sm text-muted">{note}</p>
      {state.kind === 'on-sale' ? (
        // A plain link: the public page has no auth code; logging in (if needed) and holding the
        // tickets happen on the booking page.
        <Link
          href={`/book/${event.slug}?tier=${tier.id}`}
          className="mt-auto rounded-control bg-brand-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-brand-700"
        >
          Book
        </Link>
      ) : (
        <span className="mt-auto rounded-control bg-brand-600/50 px-4 py-2 text-center text-sm font-medium text-white">
          {state.kind === 'sold-out' ? 'Sold out' : 'Unavailable'}
        </span>
      )}
    </div>
  );
}
