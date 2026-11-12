import { formatPaise, type PublicEventView, type TierView } from '@festpass/shared';
import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { formatEventTime } from '@/lib/dates';
import { getPublicEvent } from '@/lib/public-api';
import { tierState } from '@/lib/tier-state';

export const revalidate = 60;

// Nothing is built ahead of time: each event page is rendered on its first visit, then cached (ISR).
// Builds don't need the API, and a new event never waits for a deploy.
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ slug: string }> };

const summary = (e: PublicEventView) =>
  (e.description.trim() || `${e.venue} · ${formatEventTime(e.startsAt)}`).slice(0, 160);

// Next de-duplicates the identical fetch in generateMetadata and the page, so the API is called once.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const event = await getPublicEvent((await params).slug);
  if (!event) return { title: 'Event not found' };
  const description = summary(event);
  const images = event.bannerUrl ? [{ url: event.bannerUrl, alt: event.title }] : undefined;
  return {
    title: event.title,
    description,
    // What WhatsApp, LinkedIn and X show when the link is shared.
    openGraph: { type: 'website', title: event.title, description, images, siteName: 'FestPass' },
    twitter: { card: images ? 'summary_large_image' : 'summary', title: event.title, description },
  };
}

export default async function EventPage({ params }: Props) {
  const event = await getPublicEvent((await params).slug);
  if (!event) notFound(); // unknown slug or a draft: the API answers 404 for both

  const now = new Date();
  return (
    <article className="flex flex-col gap-8">
      <div className="relative aspect-[3/1] overflow-hidden rounded-card bg-gradient-to-br from-brand-600 to-brand-700">
        {event.bannerUrl && (
          <Image
            src={event.bannerUrl}
            alt={`Banner for ${event.title}`}
            fill
            preload
            sizes="(min-width: 1024px) 976px, 100vw"
            className="object-cover"
          />
        )}
      </div>

      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-600">{event.org.name}</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>
          {event.status === 'CLOSED' && <Badge>Booking closed</Badge>}
        </div>
        <dl className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">When</dt>
          <dd>
            {formatEventTime(event.startsAt)} to {formatEventTime(event.endsAt)}
          </dd>
          <dt className="text-muted">Where</dt>
          <dd>{event.venue}</dd>
          <dt className="text-muted">Tickets on sale</dt>
          <dd>
            {formatEventTime(event.saleStartsAt)} to {formatEventTime(event.saleEndsAt)}
          </dd>
        </dl>
      </header>

      {event.description && (
        <section aria-labelledby="about">
          <h2 id="about" className="mb-2 text-xl font-semibold">
            About
          </h2>
          <p className="max-w-3xl whitespace-pre-line text-ink/90">{event.description}</p>
        </section>
      )}

      <section aria-labelledby="tickets">
        <h2 id="tickets" className="mb-4 text-xl font-semibold">
          Tickets
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {event.tiers.map((tier) => (
            <li key={tier.id}>
              <TierCard tier={tier} event={event} now={now} />
            </li>
          ))}
        </ul>
        {/* The design rule for cached pages: availability here is a hint, never a promise. */}
        <p className="mt-4 text-xs text-muted">
          Availability on this page is refreshed at least once a minute. Every booking is checked
          against live stock, so you are never sold a ticket that is already gone.
        </p>
      </section>
    </article>
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
      {/* shortcut: not wired yet; booking (Day 11) and checkout (Day 15) turn this into the real flow. */}
      <button
        type="button"
        disabled
        className="mt-auto rounded-control bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-brand-600/50"
      >
        {state.kind === 'on-sale' ? 'Book' : state.kind === 'sold-out' ? 'Sold out' : 'Unavailable'}
      </button>
    </div>
  );
}
