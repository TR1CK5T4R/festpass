'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  addMemberSchema,
  can,
  ORG_ROLES,
  type OrgMemberView,
  type OrgRole,
  type OrgSummary,
} from '@festpass/shared';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, showApiError } from '@/lib/form-errors';
import { useOrgs } from '@/lib/orgs';
import { useApiData } from '@/lib/use-api-data';

const ROLE_HELP: Record<OrgRole, string> = {
  OWNER: 'Everything, including the team',
  MANAGER: 'Events, tiers and publishing',
  SCANNER: 'Scans tickets at the gate',
};

export default function MembersPage() {
  const { current } = useOrgs();
  if (!current) return <p className="text-sm text-muted">Loading…</p>;
  return <Members key={current.id} org={current} />;
}

function Members({ org }: { org: OrgSummary }) {
  const { data, error, reload } = useApiData<{ members: OrgMemberView[] }>(`/orgs/${org.id}`);
  const { user } = useAuth();
  const { reload: reloadOrgs } = useOrgs();
  const [removing, setRemoving] = useState<OrgMemberView | null>(null);
  const toast = useToast();
  // The UI only hides controls; the API checks member:manage on every call.
  const canManage = can(org.role, 'member:manage');
  const membersPath = `/orgs/${org.id}/members`;

  async function changeRole(member: OrgMemberView, role: OrgRole) {
    try {
      await api.request(`${membersPath}/${member.userId}`, { method: 'PATCH', body: { role } });
      toast(`${member.name} is now ${role}`);
      // Changing your own role changes what this dashboard lets you do.
      if (member.userId === user?.id) await reloadOrgs();
    } catch (err) {
      toast(errorMessage(err), 'error'); // e.g. LAST_OWNER: the club must keep an owner
    }
    reload();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{org.name} team</h1>
      {canManage && <AddMemberForm path={membersPath} onAdded={reload} />}
      <Card>
        <h2 className="mb-4 font-semibold">Members</h2>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(error)}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {data?.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{m.name}</span>
                  {m.userId === user?.id && <span className="text-muted"> (you)</span>}
                  <span className="block text-muted">{m.email}</span>
                </span>
                {canManage ? (
                  <>
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>
                      Role of {m.name}
                    </label>
                    <select
                      id={`role-${m.userId}`}
                      value={m.role}
                      onChange={(e) => void changeRole(m, e.target.value as OrgRole)}
                      className="rounded-control border border-line bg-surface px-2 py-1.5 text-sm"
                    >
                      {ORG_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" onClick={() => setRemoving(m)}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <Badge>{m.role}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name}?`}
        confirmLabel="Remove"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.request(`${membersPath}/${removing!.userId}`, { method: 'DELETE' });
          toast(`${removing!.name} removed`);
          if (removing!.userId === user?.id) await reloadOrgs();
          reload();
        }}
      >
        They lose access to {org.name} right away. You can add them again later.
      </ConfirmDialog>
    </div>
  );
}

function AddMemberForm({ path, onAdded }: { path: string; onAdded: () => void }) {
  const form = useForm({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: '', role: 'SCANNER' as OrgRole },
  });
  const { errors, isSubmitting } = form.formState;
  const role = useWatch({ control: form.control, name: 'role' });
  const toast = useToast();

  const submit = form.handleSubmit(async (input) => {
    try {
      const { member } = await api.request<{ member: OrgMemberView }>(path, {
        method: 'POST',
        body: input,
      });
      toast(`${member.name} added as ${member.role}`);
      form.reset();
      onAdded();
    } catch (err) {
      // NOT_FOUND here means no account has that email: they need to register first.
      showApiError(err, form.setError, { NOT_FOUND: 'email', ALREADY_MEMBER: 'email' });
    }
  });

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Add a member</h2>
      <p className="mb-4 text-sm text-muted">They need a FestPass account with this email first.</p>
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-start"
      >
        <Input
          label="Email"
          type="email"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Select
          label="Role"
          hint={ROLE_HELP[role]}
          error={errors.role?.message}
          {...form.register('role')}
        >
          {ORG_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Button type="submit" loading={isSubmitting} className="sm:mt-6">
          Add
        </Button>
        {errors.root?.server && (
          <p role="alert" className="text-sm text-danger sm:col-span-3">
            {errors.root.server.message}
          </p>
        )}
      </form>
    </Card>
  );
}
