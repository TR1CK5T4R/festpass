import type { CountBy, SponsorAnalytics } from '@festpass/shared';
import type { PipelineStage } from 'mongoose';
import { ScanEvent } from './scan-event.js';

/** Branches or years with fewer visitors than this are folded into "Other" (see foldSmall). */
export const MIN_GROUP_SIZE = 3;
export const OTHER = 'Other';

const booth = { 'meta.type': 'BOOTH' };

/** One row per visitor (ticket), with how often they came and who they are. Booth scans only. */
const perVisitor = (field?: string): PipelineStage.FacetPipelineStage[] => [
  { $match: booth },
  {
    $group: {
      _id: '$ticketId',
      visits: { $sum: 1 },
      ...(field && { value: { $first: `$${field}` } }),
    },
  },
];

/**
 * Unique visitors per value, with every value under MIN_GROUP_SIZE folded into "Other": a sponsor must
 * not be able to learn that the single ECE student from 2025 stopped by. Folded in the database, so a
 * small group's count never leaves it.
 */
const breakdown = (field: string): PipelineStage.FacetPipelineStage[] => [
  ...perVisitor(field),
  { $group: { _id: '$value', count: { $sum: 1 } } },
  {
    $group: {
      _id: { $cond: [{ $gte: ['$count', MIN_GROUP_SIZE] }, '$_id', OTHER] },
      count: { $sum: '$count' },
    },
  },
  { $sort: { count: -1, _id: 1 } },
  { $project: { _id: 0, value: '$_id', count: 1 } },
];

/**
 * The sponsor dashboard's aggregation. One $match takes the event's accepted gate entries (for
 * attendance) and the accepted visits to this sponsor's booths only, then $facet splits them. Repeat
 * visitors come from grouping twice: first by ticket (visits per person), then over those rows
 * (people, and people with more than one visit). Ticket IDs are grouped on, never returned.
 */
export function sponsorPipeline(eventId: string, boothIds: string[]): PipelineStage[] {
  return [
    {
      $match: {
        'meta.eventId': eventId,
        result: 'ACCEPTED',
        $or: [{ 'meta.type': 'GATE' }, { ...booth, 'meta.gateOrBoothId': { $in: boothIds } }],
      },
    },
    {
      $facet: {
        attendance: [
          { $match: { 'meta.type': 'GATE' } },
          { $group: { _id: '$ticketId' } },
          { $count: 'n' },
        ],
        visitors: [
          ...perVisitor(),
          {
            $group: {
              _id: null,
              uniqueVisitors: { $sum: 1 },
              repeatVisitors: { $sum: { $cond: [{ $gt: ['$visits', 1] }, 1, 0] } },
              visits: { $sum: '$visits' },
            },
          },
        ],
        booths: [
          { $match: booth },
          {
            $group: {
              _id: '$meta.gateOrBoothId',
              visits: { $sum: 1 },
              visitors: { $addToSet: '$ticketId' },
            },
          },
          {
            $project: {
              _id: 0,
              boothId: '$_id',
              visits: 1,
              uniqueVisitors: { $size: '$visitors' },
            },
          },
        ],
        heatmap: [
          { $match: booth },
          {
            $group: {
              // Whole hours in India time: in UTC they would start at :30 for anyone reading in IST.
              _id: {
                boothId: '$meta.gateOrBoothId',
                hour: { $dateTrunc: { date: '$ts', unit: 'hour', timezone: 'Asia/Kolkata' } },
              },
              visits: { $sum: 1 },
            },
          },
          { $sort: { '_id.hour': 1, '_id.boothId': 1 } },
          { $project: { _id: 0, boothId: '$_id.boothId', hour: '$_id.hour', visits: 1 } },
        ],
        branch: breakdown('branch'),
        graduationYear: breakdown('graduationYear'),
      },
    },
  ];
}

export interface SponsorVisitStats {
  attendance: number;
  uniqueVisitors: number;
  repeatVisitors: number;
  visits: number;
  booths: { boothId: string; visits: number; uniqueVisitors: number }[];
  heatmap: { boothId: string; hour: string; visits: number }[];
  breakdown: {
    branch: CountBy<string | null>[];
    graduationYear: CountBy<number | string | null>[];
  };
}

interface Raw {
  attendance: { n: number }[];
  visitors: { uniqueVisitors: number; repeatVisitors: number; visits: number }[];
  booths: SponsorVisitStats['booths'];
  heatmap: { boothId: string; hour: Date; visits: number }[];
  branch: CountBy<string | null>[];
  graduationYear: CountBy<number | string | null>[];
}

/** The numbers for one sponsor's booths at one event. The caller has already checked who may see them. */
export async function sponsorVisitStats(
  eventId: string,
  boothIds: string[],
): Promise<SponsorVisitStats> {
  const [raw] = await ScanEvent.aggregate<Raw>(sponsorPipeline(eventId, boothIds));
  const visitors = raw!.visitors[0] ?? { uniqueVisitors: 0, repeatVisitors: 0, visits: 0 };
  return {
    attendance: raw!.attendance[0]?.n ?? 0,
    ...visitors,
    booths: raw!.booths,
    heatmap: raw!.heatmap.map((h) => ({ ...h, hour: h.hour.toISOString() })),
    breakdown: { branch: raw!.branch, graduationYear: raw!.graduationYear },
  };
}

interface SponsorRef {
  id: string;
  name: string;
  tier: SponsorAnalytics['sponsor']['tier'];
  event: { id: string; title: string; startsAt: Date; status: string };
  booths: { id: string; name: string }[];
}

/**
 * The whole dashboard (and report) for one sponsor: the numbers from sponsorPipeline plus the names
 * from Postgres. Used by the API and by the worker's post-event report, so the two always agree.
 */
export async function sponsorAnalytics(sponsor: SponsorRef): Promise<SponsorAnalytics> {
  const stats = await sponsorVisitStats(
    sponsor.event.id,
    sponsor.booths.map((b) => b.id),
  );
  const byBooth = new Map(stats.booths.map((b) => [b.boothId, b]));
  return {
    sponsor: { id: sponsor.id, name: sponsor.name, tier: sponsor.tier },
    event: {
      id: sponsor.event.id,
      title: sponsor.event.title,
      startsAt: sponsor.event.startsAt.toISOString(),
      status: sponsor.event.status,
    },
    minGroupSize: MIN_GROUP_SIZE,
    totals: {
      uniqueVisitors: stats.uniqueVisitors,
      repeatVisitors: stats.repeatVisitors,
      visits: stats.visits,
      attendance: stats.attendance,
      shareOfAttendance:
        stats.attendance === 0
          ? null
          : Math.round((stats.uniqueVisitors / stats.attendance) * 1000) / 1000,
    },
    booths: sponsor.booths.map((b) => ({
      id: b.id,
      name: b.name,
      visits: byBooth.get(b.id)?.visits ?? 0,
      uniqueVisitors: byBooth.get(b.id)?.uniqueVisitors ?? 0,
    })),
    heatmap: stats.heatmap,
    breakdown: stats.breakdown,
  };
}
