'use client';

import { can, type EventView } from '@festpass/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { BannerUploader } from '@/components/events/banner-uploader';
import { EventActions } from '@/components/events/event-actions';
import { EventForm } from '@/components/events/event-form';
import { StatusBadge } from '@/components/events/status-badge';
import { TierEditor } from '@/components/events/tier-editor';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { errorMessage } from '@/lib/form-errors';
import { useOrgs } from '@/lib/orgs';
import { useApiData } from '@/lib/use-api-data';

// The org is in the URL (not only in the switcher) so a link to an event works for any teammate and
// survives a reload.
export default function EventPage() {
  const { orgId, eventId } = useParams<{ orgId: string; eventId: string }>();
  const { orgs, current, select } = useOrgs();
  const { data, error, reload, setData } = useApiData<{ event: EventView }>(
    `/orgs/${orgId}/events/${eventId}`,
  );
  const toast = useToast();

  useEffect(() => {
    if (orgs && current?.id !== orgId) select(orgId);
  }, [orgs, current, orgId, select]);

  const role = orgs?.find((o) => o.id === orgId)?.role;
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {errorMessage(error)}{' '}
        <Link href="/dashboard" className="underline">
          Back to events
        </Link>
      </p>
    );
  }
  if (!data || !role) return <p className="text-sm text-muted">Loading event…</p>;

  const { event } = data;
  const setEvent = (next: EventView) => setData({ event: next });
  const closed = event.status === 'CLOSED';
  const canEdit = can(role, 'event:update') && !closed;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <Link href="/dashboard" className="text-sm text-muted hover:text-ink">
            ← Events
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{event.title}</h1>
            <StatusBadge status={event.status} />
          </div>
          <p className="text-sm text-muted">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {can(role, 'event:publish') && <EventActions event={event} onChange={setEvent} />}
        </div>
      </div>

      {closed && (
        <p className="rounded-control border border-line bg-canvas px-4 py-3 text-sm text-muted">
          This event is closed, so it can no longer be edited.
        </p>
      )}

      <BannerUploader event={event} canEdit={canEdit} onChange={setEvent} />
      <TierEditor event={event} canEdit={canEdit} onChanged={reload} />
      <Card>
        <h2 className="mb-4 font-semibold">Details</h2>
        <EventForm
          key={event.status}
          event={event}
          submitLabel="Save changes"
          disabled={!canEdit}
          onSubmit={async (input) => {
            const res = await api.request<{ event: EventView }>(
              `/orgs/${orgId}/events/${eventId}`,
              { method: 'PATCH', body: input },
            );
            setEvent(res.event);
            toast('Changes saved');
          }}
        />
      </Card>
    </div>
  );
}
