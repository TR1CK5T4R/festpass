'use client';

import { can, type EventSummary, type OrgSummary, type Page } from '@festpass/shared';
import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/events/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { useOrgs } from '@/lib/orgs';
import { useApiData } from '@/lib/use-api-data';

const linkButton =
  'rounded-control bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700';

export default function DashboardPage() {
  const { orgs, current } = useOrgs();

  if (!orgs) return <p className="text-sm text-muted">Loading your clubs…</p>;
  if (!current) {
    return (
      <EmptyState
        title="Create your first club"
        description="A club is an organization that runs events. You'll be its owner and can add your team later."
        action={
          <Link href="/dashboard/orgs/new" className={linkButton}>
            Create a club
          </Link>
        }
      />
    );
  }
  // Keyed by club so switching clubs starts a fresh list (and drops "load more" pages).
  return <EventList key={current.id} org={current} />;
}

function EventList({ org }: { org: OrgSummary }) {
  const first = useApiData<Page<EventSummary>>(`/orgs/${org.id}/events?limit=20`);
  const [more, setMore] = useState<Page<EventSummary>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const canCreate = can(org.role, 'event:create');

  const pages = first.data ? [first.data, ...more] : [];
  const events = pages.flatMap((p) => p.items);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await api.request<Page<EventSummary>>(
        `/orgs/${org.id}/events?limit=20&cursor=${encodeURIComponent(nextCursor!)}`,
      );
      setMore((all) => [...all, page]);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{org.name}</h1>
        <Badge tone="brand">{org.role}</Badge>
        {canCreate && (
          <Link href="/dashboard/events/new" className={`ml-auto ${linkButton}`}>
            New event
          </Link>
        )}
      </div>

      {first.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(first.error)}
        </p>
      ) : !first.data ? (
        <p className="text-sm text-muted">Loading events…</p>
      ) : events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description={
            canCreate
              ? 'Create a draft, add ticket tiers and a banner, then publish when it looks right.'
              : 'Events your club creates will show up here.'
          }
        />
      ) : (
        <Card className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-6 py-3 font-medium">Event</th>
                <th className="px-6 py-3 font-medium">Starts</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 text-right font-medium">Sold / capacity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((e) => (
                <tr key={e.id} className="hover:bg-canvas">
                  <td className="px-6 py-3">
                    <Link
                      href={`/dashboard/orgs/${org.id}/events/${e.id}`}
                      className="font-medium text-ink hover:text-brand-600"
                    >
                      {e.title}
                    </Link>
                    <div className="text-xs text-muted">{e.venue}</div>
                  </td>
                  <td className="px-6 py-3 text-muted">{formatDateTime(e.startsAt)}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums">
                    {e.capacity === 0 ? (
                      <span className="text-muted">No tiers</span>
                    ) : (
                      `${e.soldCount} / ${e.capacity}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {nextCursor && (
        <Button
          variant="secondary"
          loading={loadingMore}
          onClick={() => void loadMore()}
          className="self-center"
        >
          Load more
        </Button>
      )}
    </div>
  );
}
