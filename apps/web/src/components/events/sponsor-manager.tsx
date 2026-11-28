'use client';

import { SPONSOR_TIERS, type SponsorTier, type SponsorView } from '@festpass/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';

const tierLabel: Record<SponsorTier, string> = { TITLE: 'Title', GOLD: 'Gold', SILVER: 'Silver' };

/** A one-field form that posts and reports errors next to its field. */
function InlineForm({
  label,
  type = 'text',
  submitLabel,
  onSubmit,
}: {
  label: string;
  type?: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      setValue('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="flex-1">
        <Input
          label={label}
          type={type}
          value={value}
          error={error ?? undefined}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button type="submit" variant="secondary" loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

/**
 * The organizer's side of sponsorship: sponsors of this event, their booths, and which FestPass
 * accounts may see each sponsor's dashboard. Sponsor users see only their own booths' numbers.
 */
export function SponsorManager({ orgId, eventId }: { orgId: string; eventId: string }) {
  const base = `/orgs/${orgId}/events/${eventId}/sponsors`;
  const { data, error, reload } = useApiData<{ sponsors: SponsorView[] }>(base);
  const [tier, setTier] = useState<SponsorTier>('GOLD');
  const toast = useToast();

  const post = async (path: string, body: unknown, done: string) => {
    await api.request(path, { method: 'POST', body });
    toast(done);
    reload();
  };

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-semibold">Sponsors</h2>
        <p className="text-sm text-muted">
          Booth scans count visitors for each sponsor. Their users see totals only, never who
          visited.
        </p>
      </div>
      {error !== null && <p className="text-sm text-danger">{errorMessage(error)}</p>}
      {data?.sponsors.length === 0 && <p className="text-sm text-muted">No sponsors yet.</p>}
      {data?.sponsors.map((sponsor) => (
        <section
          key={sponsor.id}
          className="flex flex-col gap-3 rounded-control border border-line p-4"
        >
          <h3 className="font-medium">
            {sponsor.name}{' '}
            <span className="text-sm font-normal text-muted">· {tierLabel[sponsor.tier]}</span>
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Booths</p>
              <ul className="text-sm text-muted">
                {sponsor.booths.length === 0 ? (
                  <li>None yet</li>
                ) : (
                  sponsor.booths.map((b) => <li key={b.id}>{b.name}</li>)
                )}
              </ul>
              <InlineForm
                label="New booth"
                submitLabel="Add booth"
                onSubmit={(name) => post(`${base}/${sponsor.id}/booths`, { name }, 'Booth added')}
              />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Sponsor users</p>
              <ul className="flex flex-col gap-1 text-sm">
                {sponsor.members.length === 0 && <li className="text-muted">None yet</li>}
                {sponsor.members.map((m) => (
                  <li key={m.userId} className="flex items-center justify-between gap-2">
                    <span>
                      {m.name} <span className="text-muted">{m.email}</span>
                    </span>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.request(`${base}/${sponsor.id}/members/${m.userId}`, {
                            method: 'DELETE',
                          });
                          toast('Removed');
                          reload();
                        } catch (err) {
                          toast(errorMessage(err));
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <InlineForm
                label="Add by email"
                type="email"
                submitLabel="Add user"
                onSubmit={(email) =>
                  post(`${base}/${sponsor.id}/members`, { email }, 'Sponsor user added')
                }
              />
            </div>
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <Select
          label="Tier"
          value={tier}
          onChange={(e) => setTier(e.target.value as SponsorTier)}
          className="w-32"
        >
          {SPONSOR_TIERS.map((t) => (
            <option key={t} value={t}>
              {tierLabel[t]}
            </option>
          ))}
        </Select>
        <div className="min-w-56 flex-1">
          <InlineForm
            label="New sponsor"
            submitLabel="Add sponsor"
            onSubmit={(name) => post(base, { name, tier }, 'Sponsor added')}
          />
        </div>
      </div>
    </Card>
  );
}
