import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Tells the web app that an event's public pages (/e/{slug} and the list on /) changed, so their cached
 * HTML is rebuilt on the next visit instead of up to 60 s later.
 *
 * Fire and forget: the organizer's request has already succeeded, and if this call fails the pages
 * still refresh on their own within 60 s. Always called after the database work is done, never inside
 * a transaction (no network calls in transactions).
 */
export function revalidateEventPages(slug: string): void {
  fetch(env.WEB_REVALIDATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REVALIDATE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ slug }),
    signal: AbortSignal.timeout(3000),
  })
    .then((res) => {
      if (!res.ok) logger.warn({ slug, status: res.status }, 'web app refused revalidation');
    })
    .catch((err: unknown) =>
      logger.warn({ slug, err }, 'revalidation failed; the page refreshes within 60 s anyway'),
    );
}
