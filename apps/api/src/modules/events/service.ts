import { randomBytes } from 'node:crypto';
import {
  eventWindowIssues,
  tierWindowIssues,
  type CreateEventInput,
  type CreateTierInput,
  type Page,
  type PublicEventsQuery,
  type TierView,
  type UpdateEventInput,
  type UpdateTierInput,
} from '@festpass/shared';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { bodyFieldErrors, ConflictError, NotFoundError } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import { publicUrl } from '../../lib/storage.js';
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
  return toEventView(await repo.updateEvent(eventId, input));
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
  return getEvent(orgId, eventId);
}

/** PUBLISHED -> CLOSED: stays visible publicly, but no longer bookable. */
export async function closeEvent(orgId: string, eventId: string) {
  const event = await loadEvent(orgId, eventId);
  assertTransition(event.status, 'CLOSED');
  if (!(await repo.transitionStatus(eventId, 'PUBLISHED', 'CLOSED'))) throw statusChanged();
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
  return toTierView(tier);
}

export async function deleteTier(orgId: string, eventId: string, tierId: string) {
  await loadEditableEvent(orgId, eventId);
  const result = await repo.deleteUnsoldTier(eventId, tierId);
  if (result === 'NOT_FOUND') throw new NotFoundError('Tier not found');
  if (result === 'HAS_SALES') {
    throw new ConflictError('TIER_HAS_SALES', 'A tier with sold tickets cannot be deleted');
  }
}

// ---- Public side ----

/** Published events that haven't ended yet, soonest first. */
export function listPublicEvents({ cursor, limit, orgId }: PublicEventsQuery) {
  return listPage({ status: 'PUBLISHED', endsAt: { gt: new Date() }, orgId }, cursor, limit);
}

export async function getPublicEvent(slug: string) {
  const event = await repo.findPublicEventBySlug(slug);
  if (!event) throw new NotFoundError('Event not found');
  return toEventView(event);
}
