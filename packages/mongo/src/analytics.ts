import type { CheckinAnalytics } from '@festpass/shared';
import type { PipelineStage } from 'mongoose';
import { ScanEvent } from './scan-event.js';

const TOP = 10;

/** Count per value of one field, biggest first (ties by value, so the order is stable). */
const countBy = (field: string, limit?: number): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  { $sort: { count: -1, _id: 1 } },
  ...(limit ? [{ $limit: limit }] : []),
  { $project: { _id: 0, value: '$_id', count: 1 } },
];

/**
 * The aggregation behind the check-in dashboard, exported so the explain script runs the same thing.
 * One $match on the event's gate scans (served by the { meta.eventId, ts } index), then $facet runs
 * every breakdown over those same documents in one round trip. Attendee fields were copied onto each
 * scan when it was written, so none of this joins back to Postgres.
 */
export function checkinPipeline(eventId: string, bucketMinutes: number): PipelineStage[] {
  const entered = { result: 'ACCEPTED' };
  return [
    { $match: { 'meta.eventId': eventId, 'meta.type': 'GATE' } },
    {
      $facet: {
        // 5- and 15-minute buckets line up the same in UTC and India time (+05:30), so no timezone is needed.
        timeline: [
          { $match: entered },
          {
            $group: {
              _id: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: bucketMinutes } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, at: '$_id', count: 1 } },
        ],
        results: countBy('result'),
        college: [{ $match: entered }, ...countBy('college', TOP)],
        branch: [{ $match: entered }, ...countBy('branch', TOP)],
        graduationYear: [{ $match: entered }, ...countBy('graduationYear')],
        tier: [{ $match: entered }, ...countBy('tierName')],
        entered: [{ $match: entered }, { $count: 'n' }],
      },
    },
    {
      $project: {
        timeline: 1,
        results: 1,
        breakdown: {
          college: '$college',
          branch: '$branch',
          graduationYear: '$graduationYear',
          tier: '$tier',
        },
        entered: { $ifNull: [{ $first: '$entered.n' }, 0] },
        // The busiest bucket, the earliest one on a tie.
        peak: { $first: { $sortArray: { input: '$timeline', sortBy: { count: -1, at: 1 } } } },
      },
    },
  ];
}

interface Raw {
  timeline: { at: Date; count: number }[];
  results: CheckinAnalytics['results'];
  breakdown: CheckinAnalytics['breakdown'];
  entered: number;
  peak?: { at: Date; count: number };
}

export async function checkinAnalytics(
  eventId: string,
  bucketMinutes: number,
): Promise<CheckinAnalytics> {
  // $facet always returns exactly one document, even when nothing matched.
  const [raw] = await ScanEvent.aggregate<Raw>(checkinPipeline(eventId, bucketMinutes));
  const peak = raw!.peak;
  return {
    bucketMinutes,
    timeline: raw!.timeline.map((b) => ({ at: b.at.toISOString(), count: b.count })),
    peak: peak
      ? {
          at: peak.at.toISOString(),
          count: peak.count,
          perMinute: Math.round((peak.count / bucketMinutes) * 10) / 10,
        }
      : null,
    results: raw!.results,
    breakdown: raw!.breakdown,
    totals: { entered: raw!.entered },
  };
}
