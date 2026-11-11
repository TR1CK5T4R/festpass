'use client';

import {
  createTierSchema,
  formatPaise,
  paiseToRupees,
  rupeesToPaise,
  type CreateTierInput,
  type EventView,
  type TierView,
} from '@festpass/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime, fromLocalInput, toLocalInput } from '@/lib/dates';
import { showApiError } from '@/lib/form-errors';
import { sharedSchemaResolver, toNumber } from '@/lib/form-resolver';

interface TierEditorProps {
  event: EventView;
  canEdit: boolean;
  /** Called after any change so the page re-reads the event. */
  onChanged: () => void;
}

export function TierEditor({ event, canEdit, onChanged }: TierEditorProps) {
  const [editing, setEditing] = useState<TierView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TierView | null>(null);
  const toast = useToast();
  const tiersPath = `/orgs/${event.orgId}/events/${event.id}/tiers`;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Ticket tiers</h2>
        {canEdit && editing === null && (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            Add tier
          </Button>
        )}
      </div>

      {event.tiers.length === 0 ? (
        <p className="text-sm text-muted">
          No tiers yet. An event needs at least one to be published.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-2 font-medium">Tier</th>
              <th className="py-2 font-medium">Price</th>
              <th className="py-2 font-medium">Sold / capacity</th>
              <th className="py-2 font-medium">Per person</th>
              <th className="py-2 font-medium">Sale window</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {event.tiers.map((tier) => (
              <tr key={tier.id}>
                <td className="py-2 font-medium">{tier.name}</td>
                <td className="py-2">{formatPaise(tier.pricePaise)}</td>
                <td className="py-2">
                  {tier.soldCount} / {tier.capacity}
                </td>
                <td className="py-2">{tier.perUserLimit}</td>
                <td className="py-2 text-muted">
                  {tier.saleStartsAt || tier.saleEndsAt
                    ? `${tier.saleStartsAt ? formatDateTime(tier.saleStartsAt) : 'sale start'} – ${tier.saleEndsAt ? formatDateTime(tier.saleEndsAt) : 'sale end'}`
                    : 'Whole sale'}
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  {canEdit && (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(tier)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => setDeleting(tier)}>
                        Remove
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing !== null && (
        <TierForm
          key={editing === 'new' ? 'new' : editing.id}
          tier={editing === 'new' ? undefined : editing}
          path={editing === 'new' ? tiersPath : `${tiersPath}/${editing.id}`}
          onCancel={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            toast(`${name} saved`);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Remove ${deleting?.name}?`}
        confirmLabel="Remove tier"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await api.request(`${tiersPath}/${deleting!.id}`, { method: 'DELETE' });
          toast(`${deleting!.name} removed`);
          onChanged();
        }}
      >
        A tier that has sold tickets can&apos;t be removed. To stop selling it, end its sale window
        instead.
      </ConfirmDialog>
    </Card>
  );
}

interface TierFormValues {
  name: string;
  price: string;
  capacity: string;
  perUserLimit: string;
  saleStartsAt: string;
  saleEndsAt: string;
}

// People type rupees; the API takes integer paise. rupeesToPaise is the shared, tested conversion.
// Errors on pricePaise are shown on the "price" input.
const resolver = sharedSchemaResolver(
  createTierSchema,
  (v: TierFormValues) => ({
    name: v.name,
    pricePaise: rupeesToPaise(v.price) ?? NaN,
    capacity: toNumber(v.capacity),
    perUserLimit: toNumber(v.perUserLimit),
    // Empty means "the event's sale window".
    saleStartsAt: v.saleStartsAt ? fromLocalInput(v.saleStartsAt) : null,
    saleEndsAt: v.saleEndsAt ? fromLocalInput(v.saleEndsAt) : null,
  }),
  { pricePaise: 'price' },
);

interface TierFormProps {
  tier?: TierView;
  path: string;
  onCancel: () => void;
  onSaved: (name: string) => void;
}

function TierForm({ tier, path, onCancel, onSaved }: TierFormProps) {
  const form = useForm<TierFormValues, unknown, CreateTierInput>({
    resolver,
    defaultValues: {
      name: tier?.name ?? '',
      price: tier ? paiseToRupees(tier.pricePaise) : '',
      capacity: tier ? String(tier.capacity) : '',
      perUserLimit: String(tier?.perUserLimit ?? 4),
      saleStartsAt: toLocalInput(tier?.saleStartsAt ?? null),
      saleEndsAt: toLocalInput(tier?.saleEndsAt ?? null),
    },
  });
  const { errors, isSubmitting } = form.formState;
  const sold = (tier?.soldCount ?? 0) > 0;

  const submit = form.handleSubmit(async (input) => {
    try {
      await api.request(path, { method: tier ? 'PATCH' : 'POST', body: input });
      onSaved(input.name);
    } catch (err) {
      showApiError(
        err,
        form.setError,
        { TIER_NAME_TAKEN: 'name', PRICE_LOCKED: 'price', CAPACITY_LOCKED: 'capacity' },
        { pricePaise: 'price' },
      );
    }
  });

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-4 flex flex-col gap-4 rounded-control border border-line bg-canvas p-4"
    >
      <h3 className="text-sm font-semibold">{tier ? `Edit ${tier.name}` : 'New tier'}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Name"
          placeholder="Early bird"
          error={errors.name?.message}
          {...form.register('name')}
        />
        <Input
          label="Price (₹)"
          inputMode="decimal"
          placeholder="299 or 99.99, 0 for free"
          hint={sold ? 'Locked: tickets have already been sold at this price.' : undefined}
          readOnly={sold}
          error={errors.price?.message}
          {...form.register('price')}
        />
        <Input
          type="number"
          label="Capacity"
          hint={sold ? 'Can only go up once tickets are sold.' : undefined}
          error={errors.capacity?.message}
          {...form.register('capacity')}
        />
        <Input
          type="number"
          label="Max per person"
          error={errors.perUserLimit?.message}
          {...form.register('perUserLimit')}
        />
        <Input
          type="datetime-local"
          label="Tier sale opens (optional)"
          hint="Leave empty to follow the event's sale window."
          error={errors.saleStartsAt?.message}
          {...form.register('saleStartsAt')}
        />
        <Input
          type="datetime-local"
          label="Tier sale closes (optional)"
          error={errors.saleEndsAt?.message}
          {...form.register('saleEndsAt')}
        />
      </div>
      {errors.root?.server && (
        <p role="alert" className="text-sm text-danger">
          {errors.root.server.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting}>
          {tier ? 'Save tier' : 'Add tier'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
