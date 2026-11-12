import { z } from 'zod';
import { paginationQuerySchema } from './pagination.ts';

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// ISO 8601 with a timezone (`2026-12-12T10:00:00+05:30` or `...Z`), turned into a Date (stored as UTC).
const dateTime = z.iso
  .datetime({ offset: true, error: 'Enter a date and time' })
  .transform((s) => new Date(s));
const wholeNumber = () => z.number({ error: 'Enter a whole number' }).int('Enter a whole number');

export interface FieldIssue {
  path: string;
  message: string;
}

export interface EventWindow {
  startsAt: Date;
  endsAt: Date;
  saleStartsAt: Date;
  saleEndsAt: Date;
}

/** Rules for an event's dates. Exported so the API can re-check them after a partial update. */
export function eventWindowIssues(e: EventWindow): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (e.endsAt <= e.startsAt) issues.push({ path: 'endsAt', message: 'Must be after startsAt' });
  if (e.saleEndsAt <= e.saleStartsAt) {
    issues.push({ path: 'saleEndsAt', message: 'Must be after saleStartsAt' });
  }
  if (e.saleEndsAt > e.endsAt) {
    issues.push({
      path: 'saleEndsAt',
      message: 'Ticket sales must end by the time the event ends',
    });
  }
  return issues;
}

export interface TierWindow {
  saleStartsAt?: Date | null;
  saleEndsAt?: Date | null;
}

/** A tier may sell for a shorter window (e.g. early bird), but only inside the event's sale window. */
export function tierWindowIssues(
  tier: TierWindow,
  event: Pick<EventWindow, 'saleStartsAt' | 'saleEndsAt'>,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const start = tier.saleStartsAt ?? event.saleStartsAt;
  const end = tier.saleEndsAt ?? event.saleEndsAt;
  if (start < event.saleStartsAt) {
    issues.push({ path: 'saleStartsAt', message: "Must not be before the event's sale start" });
  }
  if (end > event.saleEndsAt) {
    issues.push({ path: 'saleEndsAt', message: "Must not be after the event's sale end" });
  }
  if (end <= start) issues.push({ path: 'saleEndsAt', message: 'Must be after the sale start' });
  return issues;
}

const addIssues = (issues: FieldIssue[], ctx: z.RefinementCtx) => {
  for (const i of issues) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
};

const eventFields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).default(''),
  venue: z.string().trim().min(1).max(200),
  startsAt: dateTime,
  endsAt: dateTime,
  saleStartsAt: dateTime,
  saleEndsAt: dateTime,
  // Waiting room for flash sales: when on, people are let into booking at admitRatePerSec.
  queueMode: z.boolean(),
  admitRatePerSec: wholeNumber().min(1).max(1000),
};

// Queue settings may be left out on create (the database defaults to off, 50/s). Defaults are not set
// here, because .partial() on the update schema would then reset them on every unrelated edit.
export const createEventSchema = z
  .object({
    ...eventFields,
    queueMode: eventFields.queueMode.optional(),
    admitRatePerSec: eventFields.admitRatePerSec.optional(),
  })
  .superRefine((e, ctx) => addIssues(eventWindowIssues(e), ctx));
export type CreateEventInput = z.infer<typeof createEventSchema>;

// Dates are re-checked in the API after merging with the stored event, since one date alone can't be judged.
// bannerKey comes from POST /uploads/presign; null removes the banner. The API checks the object exists.
export const updateEventSchema = z
  .object({
    ...eventFields,
    description: z.string().trim().max(5000),
    bannerKey: z.string().min(1).max(300).nullable(),
  })
  .partial()
  .refine((e) => Object.keys(e).length > 0, 'Nothing to update');
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

const tierFields = {
  name: z.string().trim().min(1).max(60),
  pricePaise: z.number({ error: 'Enter an amount like 299 or 99.99' }).int().min(0),
  capacity: wholeNumber().positive(),
  perUserLimit: wholeNumber().min(1).max(10),
  saleStartsAt: dateTime.nullable(),
  saleEndsAt: dateTime.nullable(),
};

export const createTierSchema = z.object({
  ...tierFields,
  perUserLimit: tierFields.perUserLimit.default(4),
  saleStartsAt: tierFields.saleStartsAt.optional(),
  saleEndsAt: tierFields.saleEndsAt.optional(),
});
export type CreateTierInput = z.infer<typeof createTierSchema>;

export const updateTierSchema = z
  .object(tierFields)
  .partial()
  .refine((t) => Object.keys(t).length > 0, 'Nothing to update');
export type UpdateTierInput = z.infer<typeof updateTierSchema>;

export const eventParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid() });
export const tierParamsSchema = z.object({ orgId: z.uuid(), eventId: z.uuid(), tierId: z.uuid() });
export const eventSlugParamsSchema = z.object({ slug: z.string().min(1).max(80) });

/** API -> web: "this event's public pages changed". Only real slugs, so it can't name another path. */
export const revalidateEventSchema = z.object({
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});

export const publicEventsQuerySchema = paginationQuerySchema.extend({ orgId: z.uuid().optional() });
export type PublicEventsQuery = z.infer<typeof publicEventsQuerySchema>;

/** An event as the organizer endpoints return it. Dates are ISO strings in UTC. */
export interface EventView {
  id: string;
  orgId: string;
  title: string;
  slug: string;
  description: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  saleStartsAt: string;
  saleEndsAt: string;
  status: EventStatus;
  bannerKey: string | null;
  bannerUrl: string | null;
  queueMode: boolean;
  admitRatePerSec: number;
  tiers: TierView[];
}

/** An event on its public page: also says which club runs it. */
export interface PublicEventView extends EventView {
  org: { id: string; name: string; slug: string };
}

/** A row of an event list: no tiers, but their totals. */
export interface EventSummary extends Omit<
  EventView,
  'tiers' | 'description' | 'queueMode' | 'admitRatePerSec'
> {
  org: { name: string; slug: string };
  capacity: number;
  soldCount: number;
}

export interface TierView {
  id: string;
  name: string;
  pricePaise: number;
  capacity: number;
  soldCount: number;
  /** capacity - soldCount at read time; only a hint, the booking engine rechecks. */
  available: number;
  perUserLimit: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
}
