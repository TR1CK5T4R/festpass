'use client';

import type { SponsorAnalytics } from '@festpass/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SponsorDashboard } from '@/components/sponsors/sponsor-dashboard';
import { errorMessage } from '@/lib/form-errors';
import { formatDateTime } from '@/lib/dates';
import { useApiData } from '@/lib/use-api-data';

/** One sponsorship's dashboard. The API answers only the sponsor's own users (404 for anyone else). */
export default function SponsorDashboardPage() {
  const { sponsorId } = useParams<{ sponsorId: string }>();
  const { data, error } = useApiData<{ analytics: SponsorAnalytics }>(
    `/sponsors/${sponsorId}/analytics`,
  );
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {errorMessage(error)}{' '}
        <Link href="/sponsor" className="underline">
          Back to your sponsorships
        </Link>
      </p>
    );
  }
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  const { analytics } = data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/sponsor" className="text-sm text-muted hover:text-ink">
          ← Sponsorships
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{analytics.sponsor.name}</h1>
        <p className="text-sm text-muted">
          {analytics.event.title} · {formatDateTime(analytics.event.startsAt)}
        </p>
      </div>
      <SponsorDashboard analytics={analytics} />
    </div>
  );
}
