'use client';

import type { Sponsorship } from '@festpass/shared';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';

/** The sponsor portal: every sponsorship this account belongs to. */
export default function SponsorPortalPage() {
  const { data, error } = useApiData<{ sponsorships: Sponsorship[] }>('/sponsors/mine');
  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  if (data.sponsorships.length === 0) {
    return (
      <EmptyState
        title="No sponsorships yet"
        description="When an event's organizers add you as a sponsor user, your booths' numbers appear here."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Sponsor portal</h1>
      {data.sponsorships.map((s) => (
        <Link key={s.sponsorId} href={`/sponsor/${s.sponsorId}`}>
          <Card className="transition hover:border-brand-500">
            <p className="text-sm text-brand-600">{s.name}</p>
            <h2 className="font-semibold">{s.event.title}</h2>
            <p className="text-sm text-muted">
              {formatDateTime(s.event.startsAt)} · {s.booths.length}{' '}
              {s.booths.length === 1 ? 'booth' : 'booths'}
            </p>
          </Card>
        </Link>
      ))}
    </div>
  );
}
