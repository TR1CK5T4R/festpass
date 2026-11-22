'use client';

import { can, type EventSummary, type OrgSummary, type Page } from '@festpass/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/form-errors';
import type { SavedGate } from '@/lib/scan/store';
import { useApiData } from '@/lib/use-api-data';

/** Pick a club, an event and a gate. Needs the network once; the choice is remembered on this phone. */
export function GateSetup({ onOpen }: { onOpen: (gate: SavedGate) => void }) {
  const orgs = useApiData<{ orgs: OrgSummary[] }>('/orgs/mine');
  const scannable = orgs.data?.orgs.filter((o) => can(o.role, 'checkin:scan')) ?? [];
  const [pickedOrg, setPickedOrg] = useState<string | null>(null);
  const orgId = pickedOrg ?? scannable[0]?.id ?? null;
  // shortcut: the latest 100 events of the club; add paging if a club ever runs more at once.
  const events = useApiData<Page<EventSummary>>(orgId ? `/orgs/${orgId}/events?limit=100` : null);
  const open = events.data?.items.filter((e) => e.status !== 'DRAFT') ?? [];
  const [pickedEvent, setPickedEvent] = useState<string | null>(null);
  const eventId = open.some((e) => e.id === pickedEvent) ? pickedEvent : (open[0]?.id ?? null);
  const [gateId, setGateId] = useState('main');

  const error = orgs.error ?? events.error;
  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!orgs.data) return <p className="text-sm text-muted">Loading…</p>;
  if (scannable.length === 0) {
    return (
      <EmptyState
        title="No clubs to scan for"
        description="Ask a club owner to add you as a scanner, then come back here."
      />
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const event = open.find((candidate) => candidate.id === eventId);
    if (event)
      onOpen({ eventId: event.id, eventTitle: event.title, gateId: gateId.trim() || 'main' });
  };

  return (
    <Card>
      <h1 className="mb-4 text-lg font-semibold">Open a gate</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {scannable.length > 1 && (
          <Select label="Club" value={orgId ?? ''} onChange={(e) => setPickedOrg(e.target.value)}>
            {scannable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        )}
        {events.data && open.length === 0 ? (
          <p className="text-sm text-muted">This club has no published events yet.</p>
        ) : (
          <Select
            label="Event"
            value={eventId ?? ''}
            onChange={(e) => setPickedEvent(e.target.value)}
          >
            {open.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </Select>
        )}
        <Input
          label="Gate"
          value={gateId}
          maxLength={100}
          hint="Any name, e.g. north-gate. Reports count scans per gate."
          onChange={(e) => setGateId(e.target.value)}
        />
        <Button type="submit" disabled={!eventId}>
          Open gate
        </Button>
      </form>
    </Card>
  );
}
