import type { PublicEventView } from '@festpass/shared';
import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { LiveTiers } from '@/components/events/live-tiers';
import { Badge } from '@/components/ui/badge';
import { formatEventTime } from '@/lib/dates';
import { getPublicEvent } from '@/lib/public-api';

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
        <LiveTiers event={event} renderedAt={new Date().toISOString()} />
      </section>
    </article>
  );
}
