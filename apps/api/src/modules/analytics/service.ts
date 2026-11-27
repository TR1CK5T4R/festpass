import { checkinAnalytics } from '@festpass/mongo';
import type { CheckinAnalytics, SalesAnalytics } from '@festpass/shared';
import { cached } from '../../lib/cache.js';
import { NotFoundError } from '../../lib/errors.js';
import * as repo from './repository.js';

// Dashboards are read far more often than they need to change, and each read is an aggregation over
// every order or scan of the event. Cached for 30 s (lib/cache.ts): a dozen organizers refreshing
// during the gate rush cost one aggregation per 30 s, and numbers are at most 30 s behind.

async function assertOrgEvent(orgId: string, eventId: string) {
  // Same answer for "no such event" and "another club's event", so event IDs can't be probed.
  if (!(await repo.eventBelongsToOrg(orgId, eventId))) throw new NotFoundError('Event not found');
}

export async function sales(orgId: string, eventId: string): Promise<SalesAnalytics> {
  await assertOrgEvent(orgId, eventId);
  const result = await cached<SalesAnalytics>(`cache:analytics:sales:${eventId}`, async () => {
    const [tiers, days] = await Promise.all([repo.tierSales(eventId), repo.salesByDay(eventId)]);
    return {
      tiers,
      days,
      totals: {
        tickets: tiers.reduce((sum, t) => sum + t.paid, 0),
        revenuePaise: tiers.reduce((sum, t) => sum + t.revenuePaise, 0),
      },
    };
  });
  return result!;
}

export async function checkins(
  orgId: string,
  eventId: string,
  bucketMinutes: number,
): Promise<CheckinAnalytics> {
  await assertOrgEvent(orgId, eventId);
  const result = await cached<CheckinAnalytics>(
    `cache:analytics:checkins:${eventId}:${bucketMinutes}`,
    () => checkinAnalytics(eventId, bucketMinutes),
  );
  return result!;
}
