import { z } from 'zod';

// The organizer analytics endpoints: /orgs/:orgId/events/:eventId/analytics/*.

/** Check-in timeline bucket size in minutes. */
export const checkinAnalyticsQuerySchema = z.object({
  bucket: z.enum(['5', '15']).default('15').transform(Number),
});
export type CheckinAnalyticsQuery = z.infer<typeof checkinAnalyticsQuerySchema>;

export interface TierSales {
  tierId: string;
  name: string;
  capacity: number;
  /** Tickets in paid orders (PAID or TICKETED). */
  paid: number;
  /** Tickets in unpaid holds (PENDING), which may still be paid or go back on sale. */
  held: number;
  revenuePaise: number;
}

export interface SalesDay {
  /** A calendar day in India time, "2026-11-03". */
  day: string;
  tickets: number;
  revenuePaise: number;
}

export interface SalesAnalytics {
  tiers: TierSales[];
  /** Every day from the first paid order to the last, including days with no sales. */
  days: SalesDay[];
  totals: { tickets: number; revenuePaise: number };
}

export interface CountBy<T> {
  value: T;
  count: number;
}

export interface CheckinAnalytics {
  bucketMinutes: number;
  /** Accepted gate entries per bucket, oldest first; empty buckets are left out. */
  timeline: { at: string; count: number }[];
  /** The busiest bucket, or null before anyone has entered. */
  peak: { at: string; count: number; perMinute: number } | null;
  /** Every gate scan by result, including refusals. */
  results: CountBy<string>[];
  /** Who came in (accepted gate entries). null: the attendee didn't say. Top 10 colleges and branches. */
  breakdown: {
    college: CountBy<string | null>[];
    branch: CountBy<string | null>[];
    graduationYear: CountBy<number | null>[];
    tier: CountBy<string | null>[];
  };
  totals: { entered: number };
}
