'use client';

import type { EventView } from '@festpass/shared';
import { useRouter } from 'next/navigation';
import { EventForm } from '@/components/events/event-form';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useOrgs } from '@/lib/orgs';

export default function NewEventPage() {
  const { current } = useOrgs();
  const router = useRouter();
  const toast = useToast();

  if (!current) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <Card className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold">New event</h1>
      <p className="mb-6 text-sm text-muted">
        It starts as a draft for {current.name}. Nobody else sees it until you publish.
      </p>
      <EventForm
        submitLabel="Create draft"
        onSubmit={async (input) => {
          const { event } = await api.request<{ event: EventView }>(`/orgs/${current.id}/events`, {
            method: 'POST',
            body: input,
          });
          toast('Draft created. Add ticket tiers and a banner next.');
          router.push(`/dashboard/orgs/${current.id}/events/${event.id}`);
        }}
      />
    </Card>
  );
}
