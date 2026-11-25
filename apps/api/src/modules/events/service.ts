import { randomBytes } from 'node:crypto';
import {
  eventWindowIssues,
  tierWindowIssues,
  type CreateEventInput,
  type CreateTierInput,
  type EventSummary,
  type Page,
  type PublicEventsQuery,
  type PublicEventView,
  type TierView,
  type UpdateEventInput,
  type UpdateTierInput,
} from '@festpass/shared';
import { cached, invalidatePublicEvents, liveStock } from '../../lib/cache.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { bodyFieldErrors, ConflictError, NotFoundError } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import { revalidateEventPages } from '../../lib/revalidate.js';
import { publicUrl } from '../../lib/storage.js';
import { syncInventory } from '../orders/inventory.js';
import { verifyBanner } from '../uploads/service.js';
import * as repo from './repository.js';
import { assertTransition } from './status.js';

const SLUG_ATTEMPTS = 5;

function toTierView(t: repo.TierRecord): TierView {
  return {
    ...t,
    available: t.capacity - t.soldCount,
    saleStartsAt: t.saleStartsAt?.toISOString() ?? null,
    saleEndsAt: t.saleEndsAt?.toISOString() ?? null,
  };
}

const bannerUrl = (key: string | null) => (key ? publicUrl(key) : null);

function toEventView<T extends repo.EventRecord>(e: T) {
  return { ...e, bannerUrl: bannerUrl(e.bannerKey), tiers: e.tiers.map(toTierView) };
}

async function loadEvent(orgId: string, eventId: string) {
  const event = await repo.findOrgEvent(orgId, eventId);
  if (!event) throw new NotFoundError('Event not found');
  return event;
}

async function loadEditableEvent(orgId: string, eventId: string) {
  const event = await loadEvent(orgId, eventId);
  if (event.status === 'CLOSED') throw new ConflictError('EVENT_CLOSED', 'This event is closed');
  return event;
}

async function listPage(
  where: Parameters<typeof repo.listEvents>[0],
  cursor: string | undefined,
  limit: number,
) {
  const rows = await repo.listEvents(where, cursor ? decodeCursor(cursor) : null, limit);
  const items = rows.slice(0, limit).map(({ tiers, ...e }) => ({
    ...e,
    bannerUrl: bannerUrl(e.bannerKey),
    capacity: tiers.reduce((sum, t) => sum + t.capacity, 0),
    soldCount: tiers.reduce((sum, t) => sum + t.soldCount, 0),
  }));
  const last = items.at(-1);
  const page: Page<(typeof items)[number]> = {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  return page;
}

// ---- Organizer side ----

/**
 * The slug comes from the title. If it's taken, retry with a short random suffix ("tech-fest-3f9a");
 * the unique index decides, so two organizers creating "Tech Fest" at once can't both get "tech-fest".
 */
export async function createEvent(orgId: string, input: CreateEventInput) {
  const base = slugify(input.title, 50) || 'event';
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    const event = await repo.createEvent({ ...input, orgId, slug });
    if (event) return toEventView(event);
  }
  throw new ConflictError('SLUG_TAKEN', 'Could not find a free URL for this title; try another');
}

export async function getEvent(orgId: string, eventId: string) {
  return toEventView(await loadEvent(orgId, eventId));
}

export function listOrgEvents(orgId: string, cursor: string | undefined, limit: number) {
  return listPage({ orgId }, cursor, limit);
}

// The slug never changes after creation, so shared links keep working when the title is edited.
export async function updateEvent(orgId: string, eventId: string, input: UpdateEventInput) {
  const event = await loadEditableEvent(orgId, eventId);
  const merged = { ...event, ...input };
  const issues = eventWindowIssues(merged);
  // Moving the event's sale window must not strand a tier's own window outside it.
  for (const tier of event.tiers) {
    for (const issue of tierWindowIssues(tier, merged)) {
      issues.push({ path: 'saleStartsAt', message: `Tier "${tier.name}": ${issue.message}` });
    }
  }
  if (issues.length > 0) throw bodyFieldErrors(issues);
  // A storage round trip, so it runs before (never inside) any database write.
  // shortcut: a replaced banner's old object stays in storage; add a cleanup job if that ever costs money.
  if (input.bannerKey) await verifyBanner(orgId, eventId, input.bannerKey);
  const updated = toEventView(await repo.updateEvent(eventId, input));
  await refreshPublicPages(updated);
  return updated;
}

/**
 * Drafts have no public page, so only published or closed events need refreshing. The API's cache goes
 * first: the web app's rebuild reads from the API, so it must not be handed the old cached answer.
 */
async function refreshPublicPages(event: { slug: string; status: repo.EventRecord['status'] }) {
  if (event.status === 'DRAFT') return;
  await invalidatePublicEvents();
  revalidateEventPages(event.slug);
}

const statusChanged = () =>
  new ConflictError('INVALID_TRANSITION', 'The event status was changed by another request');

/** DRAFT -> PUBLISHED. Needs at least one tier and a start time in the future. */
export async function publishEvent(orgId: string, eventId: string) {
  const event = await loadEvent(orgId, eventId);
  assertTransition(event.status, 'PUBLISHED');
  if (event.tiers.length === 0) {
    throw new ConflictError('NO_TIERS', 'Add at least one ticket tier before publishing');
  }
  if (event.startsAt <= new Date()) {
    throw new ConflictError(
      'EVENT_IN_PAST',
      'An event that has already started cannot be published',
    );
  }
  // Guarded update: if a parallel request already published it, this one matches nothing.
  if (!(await repo.transitionStatus(eventId, 'DRAFT', 'PUBLISHED'))) throw statusChanged();
  // Also clears a cached 404 from anyone who opened the link while it was still a draft.
  await refreshPublicPages({ slug: event.slug, status: 'PUBLISHED' });
  // Redis learns each tier's stock before the first booking arrives.
  await syncInventory(eventId);
  return getEvent(orgId, eventId);
}

/** PUBLISHED -> CLOSED: stays visible publicly, but no longer bookable. */
export async function closeEvent(orgId: string, eventId: string) {
  const event = await loadEvent(orgId, eventId);
  assertTransition(event.status, 'CLOSED');
  if (!(await repo.transitionStatus(eventId, 'PUBLISHED', 'CLOSED'))) throw statusChanged();
  await refreshPublicPages({ slug: event.slug, status: 'CLOSED' });
  return getEvent(orgId, eventId);
}

// ---- Tiers ----

export async function createTier(orgId: string, eventId: string, input: CreateTierInput) {
  const event = await loadEditableEvent(orgId, eventId);
  const issues = tierWindowIssues(input, event);
  if (issues.length > 0) throw bodyFieldErrors(issues);
  const tier = await repo.createTier({ ...input, eventId });
  if (!tier)
    throw new ConflictError('TIER_NAME_TAKEN', 'This event already has a tier with that name');
  await refreshPublicPages(event);
  await syncInventory(eventId); // capacity changed (or a tier came or went)
  return toTierView(tier);
}

/**
 * Once a ticket is sold, the price is locked (people already paid it, and refunds/reports rely on it)
 * and capacity can only go up (taking away seats that may already be held or sold is never safe).
 * Checked inside updateTierLocked, under the tier's row lock, so a sale can't race the check.
 */
export async function updateTier(
  orgId: string,
  eventId: string,
  tierId: string,
  input: UpdateTierInput,
) {
  const event = await loadEditableEvent(orgId, eventId);
  const tier = await repo.updateTierLocked(eventId, tierId, (current) => {
    if (current.soldCount > 0) {
      if (input.pricePaise !== undefined && input.pricePaise !== current.pricePaise) {
        throw new ConflictError('PRICE_LOCKED', 'The price is locked once tickets are sold');
      }
      if (input.capacity !== undefined && input.capacity < current.capacity) {
        throw new ConflictError(
          'CAPACITY_LOCKED',
          'Capacity can only increase once tickets are sold',
        );
      }
    }
    const issues = tierWindowIssues({ ...current, ...input }, event);
    if (issues.length > 0) throw bodyFieldErrors(issues);
    return input;
  });
  if (!tier) throw new NotFoundError('Tier not found');
  await refreshPublicPages(event);
  await syncInventory(eventId);
  return toTierView(tier);
}

export async function deleteTier(orgId: string, eventId: string, tierId: string) {
  const event = await loadEditableEvent(orgId, eventId);
  const result = await repo.deleteUnsoldTier(eventId, tierId);
  if (result === 'NOT_FOUND') throw new NotFoundError('Tier not found');
  if (result === 'HAS_SALES') {
    throw new ConflictError('TIER_HAS_SALES', 'A tier with sold tickets cannot be deleted');
  }
  await refreshPublicPages(event);
  await syncInventory(eventId);
}

// ---- Public side ----

// Public reads are cached for 30 s (lib/cache.ts) and made stale by refreshPublicPages() on every edit.
// Sold counts change with every booking without an edit, so the list's sold / capacity totals can be up
// to 30 s old; the event page instead takes tickets left from the booking gate on every request.

/** Published events that haven't ended yet, soonest first. */
export async function listPublicEvents({ cursor, limit, orgId }: PublicEventsQuery) {
  const page = await cached<Page<EventSummary>>(
    `cache:events:list:${orgId ?? 'all'}:${limit}:${cursor ?? ''}`,
    () => listPage({ status: 'PUBLISHED', endsAt: { gt: new Date() }, orgId }, cursor, limit),
  );
  return page!;
}

export async function getPublicEvent(slug: string): Promise<PublicEventView> {
  const event = await cached<PublicEventView>(`cache:events:slug:${slug}`, async () => {
    const found = await repo.findPublicEventBySlug(slug);
    return found && toEventView(found);
  });
  if (!event) throw new NotFoundError('Event not found');
  // Where Redis has no number (or no answer), the count from Postgres stays.
  const stock = await liveStock(event.tiers.map((t) => t.id));
  return {
    ...event,
    tiers: event.tiers.map((tier, i) => {
      const left = stock[i];
      if (left == null) return tier;
      const available = Math.min(tier.capacity, Math.max(0, left));
      return { ...tier, available, soldCount: tier.capacity - available };
    }),
  };
}
