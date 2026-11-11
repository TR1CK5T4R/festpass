'use client';

import { createEventSchema, type CreateEventInput, type EventView } from '@festpass/shared';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { fromLocalInput, toLocalInput } from '@/lib/dates';
import { showApiError } from '@/lib/form-errors';
import { sharedSchemaResolver, toNumber } from '@/lib/form-resolver';

interface EventFormValues {
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  saleStartsAt: string;
  saleEndsAt: string;
  queueMode: boolean;
  admitRatePerSec: string;
}

// The create schema checks the whole event at once (including the date rules), so the edit form uses
// it too and sends every field.
const resolver = sharedSchemaResolver(createEventSchema, (v: EventFormValues) => ({
  ...v,
  startsAt: fromLocalInput(v.startsAt),
  endsAt: fromLocalInput(v.endsAt),
  saleStartsAt: fromLocalInput(v.saleStartsAt),
  saleEndsAt: fromLocalInput(v.saleEndsAt),
  admitRatePerSec: toNumber(v.admitRatePerSec),
}));

const toFormValues = (e?: EventView): EventFormValues => ({
  title: e?.title ?? '',
  description: e?.description ?? '',
  venue: e?.venue ?? '',
  startsAt: toLocalInput(e?.startsAt ?? null),
  endsAt: toLocalInput(e?.endsAt ?? null),
  saleStartsAt: toLocalInput(e?.saleStartsAt ?? null),
  saleEndsAt: toLocalInput(e?.saleEndsAt ?? null),
  queueMode: e?.queueMode ?? false,
  admitRatePerSec: String(e?.admitRatePerSec ?? 50),
});

interface EventFormProps {
  event?: EventView;
  submitLabel: string;
  disabled?: boolean;
  /** Throws the API's error; the form shows it next to the right field. */
  onSubmit: (input: CreateEventInput) => Promise<void>;
}

export function EventForm({ event, submitLabel, disabled = false, onSubmit }: EventFormProps) {
  const form = useForm<EventFormValues, unknown, CreateEventInput>({
    resolver,
    defaultValues: toFormValues(event),
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (input) => {
    try {
      await onSubmit(input);
      form.reset(form.getValues()); // the saved values become the new "clean" state
    } catch (err) {
      showApiError(err, form.setError);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <fieldset disabled={disabled} className="flex flex-col gap-4">
        <Input label="Title" error={errors.title?.message} {...form.register('title')} />
        <Textarea
          label="Description"
          hint="What happens, who it's for, what to bring."
          error={errors.description?.message}
          {...form.register('description')}
        />
        <Input label="Venue" error={errors.venue?.message} {...form.register('venue')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            type="datetime-local"
            label="Starts"
            error={errors.startsAt?.message}
            {...form.register('startsAt')}
          />
          <Input
            type="datetime-local"
            label="Ends"
            error={errors.endsAt?.message}
            {...form.register('endsAt')}
          />
          <Input
            type="datetime-local"
            label="Ticket sales open"
            error={errors.saleStartsAt?.message}
            {...form.register('saleStartsAt')}
          />
          <Input
            type="datetime-local"
            label="Ticket sales close"
            hint="No later than the end of the event."
            error={errors.saleEndsAt?.message}
            {...form.register('saleEndsAt')}
          />
        </div>
        <div className="flex flex-col gap-3 rounded-control border border-line p-4">
          <Checkbox
            label="Waiting room for the sale"
            hint="For hot sales: people queue and are let into booking a few at a time."
            {...form.register('queueMode')}
          />
          <Input
            type="number"
            min={1}
            max={1000}
            label="People admitted per second"
            hint="Only used while the waiting room is on."
            error={errors.admitRatePerSec?.message}
            {...form.register('admitRatePerSec')}
          />
        </div>
        {errors.root?.server && (
          <p role="alert" className="text-sm text-danger">
            {errors.root.server.message}
          </p>
        )}
        {!disabled && (
          <Button type="submit" loading={isSubmitting} className="self-start">
            {submitLabel}
          </Button>
        )}
      </fieldset>
    </form>
  );
}
