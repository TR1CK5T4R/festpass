'use client';

import type { EventView } from '@festpass/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';

/** Publish (DRAFT) or close (PUBLISHED). Both are one-way, so both ask first. */
export function EventActions({
  event,
  onChange,
}: {
  event: EventView;
  onChange: (event: EventView) => void;
}) {
  const [confirming, setConfirming] = useState<'publish' | 'close' | null>(null);
  const toast = useToast();

  async function run(action: 'publish' | 'close') {
    // Errors (NO_TIERS, EVENT_IN_PAST, ...) are thrown to the dialog, which shows the server's message.
    const res = await api.request<{ event: EventView }>(
      `/orgs/${event.orgId}/events/${event.id}/${action}`,
      { method: 'POST' },
    );
    onChange(res.event);
    toast(action === 'publish' ? `${event.title} is live` : `${event.title} is closed`);
  }

  if (event.status === 'CLOSED') return null;
  return (
    <>
      {event.status === 'DRAFT' ? (
        <Button onClick={() => setConfirming('publish')}>Publish</Button>
      ) : (
        <Button variant="danger" onClick={() => setConfirming('close')}>
          Close event
        </Button>
      )}
      <ConfirmDialog
        open={confirming === 'publish'}
        title={`Publish ${event.title}?`}
        confirmLabel="Publish"
        onClose={() => setConfirming(null)}
        onConfirm={() => run('publish')}
      >
        It appears on the public events list right away, and booking opens on{' '}
        {formatDateTime(event.saleStartsAt)}. A published event can&apos;t go back to draft, and a
        tier&apos;s price locks once its first ticket sells.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === 'close'}
        title={`Close ${event.title}?`}
        confirmLabel="Close event"
        danger
        onClose={() => setConfirming(null)}
        onConfirm={() => run('close')}
      >
        Booking stops for good. The event page stays public and sold tickets stay valid. This
        can&apos;t be undone.
      </ConfirmDialog>
    </>
  );
}
