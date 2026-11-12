import type { EventSummary, Page, PublicEventView } from '@festpass/shared';

// Server-side reads for the public pages. No auth: these endpoints only return published events.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// The cached response lives as long as the page that uses it (60 s, or until the API asks the web app
// to revalidate). Keep in step with `export const revalidate` on the pages.
const cached = { next: { revalidate: 60 } };

/** A published or closed event, or null when there is none with this slug (unknown, or still a draft). */
export async function getPublicEvent(slug: string): Promise<PublicEventView | null> {
  const res = await fetch(`${API}/events/${encodeURIComponent(slug)}`, cached);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API answered ${res.status} for event "${slug}"`);
  return ((await res.json()) as { event: PublicEventView }).event;
}

/** Published events that haven't ended, soonest first. */
export async function listUpcomingEvents(): Promise<EventSummary[]> {
  try {
    const res = await fetch(`${API}/events?limit=48`, cached);
    if (!res.ok) throw new Error(`API answered ${res.status} for the event list`);
    return ((await res.json()) as Page<EventSummary>).items;
  } catch (err) {
    // `next build` prerenders the home page, and the API may not be running there (e.g. in CI). Build
    // an empty list rather than failing; the first visit after 60 s, or the next publish, replaces it.
    if (process.env.NEXT_PHASE === 'phase-production-build') return [];
    throw err;
  }
}
