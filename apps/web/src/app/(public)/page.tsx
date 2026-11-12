import type { EventSummary } from '@festpass/shared';
import Image from 'next/image';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { formatEventTime } from '@/lib/dates';
import { listUpcomingEvents } from '@/lib/public-api';

// ISR: served from cache, rebuilt in the background at most once a minute, and right away when the API
// reports that an event was published or edited (POST /api/revalidate).
export const revalidate = 60;

export default async function HomePage() {
  const events = await listUpcomingEvents();
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">Upcoming college events</h1>
        <p className="mt-2 max-w-xl text-muted">
          Hackathons, fests and meetups from college clubs. Tickets stay fair even when the whole
          campus books at the same second.
        </p>
      </section>
      {events.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface px-6 py-12 text-center text-muted">
          No upcoming events right now. Check back soon.
        </p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {events.map((event, i) => (
            <li key={event.id}>
              <EventCard event={event} preload={i === 0} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventCard({ event, preload }: { event: EventSummary; preload: boolean }) {
  const soldOut = event.capacity > 0 && event.soldCount >= event.capacity;
  return (
    <Link
      href={`/e/${event.slug}`}
      className="group block overflow-hidden rounded-card border border-line bg-surface shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[3/1] bg-gradient-to-br from-brand-600 to-brand-700">
        {event.bannerUrl && (
          <Image
            src={event.bannerUrl}
            alt=""
            fill
            sizes="(min-width: 640px) 480px, 100vw"
            preload={preload}
            className="object-cover"
          />
        )}
      </div>
      <div className="flex flex-col gap-1 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold group-hover:text-brand-600">{event.title}</h2>
          {soldOut && <Badge>Sold out</Badge>}
        </div>
        <p className="text-sm text-muted">{formatEventTime(event.startsAt)}</p>
        <p className="text-sm text-muted">
          {event.venue} · by {event.org.name}
        </p>
      </div>
    </Link>
  );
}
