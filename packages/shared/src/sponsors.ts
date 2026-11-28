import { z } from 'zod';
import type { CountBy } from './analytics.ts';

// Sponsors of an event, their booths and their users; booth scans; the sponsor dashboard.

export const SPONSOR_TIERS = ['TITLE', 'GOLD', 'SILVER'] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

export const createSponsorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tier: z.enum(SPONSOR_TIERS),
});
export type CreateSponsorInput = z.infer<typeof createSponsorSchema>;

export const createBoothSchema = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateBoothInput = z.infer<typeof createBoothSchema>;

/** An existing FestPass account, by email; it becomes one of the sponsor's users. */
export const addSponsorMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

export const sponsorParamsSchema = z.object({
  orgId: z.uuid(),
  eventId: z.uuid(),
  sponsorId: z.uuid(),
});
export const sponsorMemberParamsSchema = sponsorParamsSchema.extend({ userId: z.uuid() });
export const sponsorIdParamsSchema = z.object({ sponsorId: z.uuid() });
export const boothParamsSchema = z.object({ boothId: z.uuid() });

export const boothScanSchema = z.object({
  qr: z.string().min(1).max(1000),
  deviceId: z.string().trim().min(1).max(100),
  /** Chosen by the phone; a scan re-sent after a lost answer is counted once. */
  clientScanId: z.string().min(1).max(100).optional(),
});
export type BoothScanInput = z.infer<typeof boothScanSchema>;

/** The organizer's view: who the sponsor's users are is the organizer's business, not attendees'. */
export interface SponsorView {
  id: string;
  name: string;
  tier: SponsorTier;
  booths: { id: string; name: string }[];
  members: { userId: string; name: string; email: string }[];
}

/** What a scanner picks from when opening a booth. */
export interface BoothOption {
  id: string;
  name: string;
  sponsorName: string;
}

/** What the booth phone shows. No attendee name: booth staff may be the sponsor's own people. */
export interface BoothVisit {
  boothId: string;
  tierName: string;
  at: string;
}

export interface Sponsorship {
  sponsorId: string;
  name: string;
  tier: SponsorTier;
  event: { id: string; title: string; startsAt: string; status: string };
  booths: { id: string; name: string }[];
}

/**
 * The sponsor dashboard: counts only. No names, emails or ticket IDs, and any branch or year with fewer
 * than `minGroupSize` visitors is folded into "Other", so a small group can't point at one student.
 */
export interface SponsorAnalytics {
  sponsor: { id: string; name: string; tier: SponsorTier };
  event: { id: string; title: string; startsAt: string; status: string };
  minGroupSize: number;
  totals: {
    /** Different people who visited any of the sponsor's booths. */
    uniqueVisitors: number;
    /** Of those, people who came back more than once. */
    repeatVisitors: number;
    visits: number;
    /** People who entered the event at the gate. */
    attendance: number;
    /** uniqueVisitors / attendance, or null before anyone has entered. */
    shareOfAttendance: number | null;
  };
  booths: { id: string; name: string; visits: number; uniqueVisitors: number }[];
  /** Visits per booth per hour (India time), only hours with visits. */
  heatmap: { boothId: string; hour: string; visits: number }[];
  breakdown: {
    /** Unique visitors per value; value "Other" collects the small groups, null is "not given". */
    branch: CountBy<string | null>[];
    graduationYear: CountBy<number | string | null>[];
  };
}
