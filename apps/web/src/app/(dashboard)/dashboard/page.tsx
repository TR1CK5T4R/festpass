'use client';

import type { OrgMemberView } from '@festpass/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { api } from '@/lib/api';
import { useOrgs } from '@/lib/orgs';

export default function DashboardPage() {
  const { orgs, current } = useOrgs();
  const [members, setMembers] = useState<OrgMemberView[] | null>(null);

  useEffect(() => {
    if (!current) return;
    let active = true;
    void api
      .request<{ members: OrgMemberView[] }>(`/orgs/${current.id}`)
      .then((res) => active && setMembers(res.members));
    return () => {
      active = false;
    };
  }, [current]);

  if (!orgs) return <p className="text-sm text-muted">Loading your clubs…</p>;

  if (!current) {
    return (
      <EmptyState
        title="Create your first club"
        description="A club is an organization that runs events. You'll be its owner and can add your team later."
        action={
          <Link
            href="/dashboard/orgs/new"
            className="rounded-control bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create a club
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{current.name}</h1>
        <Badge tone="brand">{current.role}</Badge>
      </div>
      <Card>
        <h2 className="mb-4 font-semibold">Team</h2>
        <ul className="divide-y divide-line">
          {members?.map((m) => (
            <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
              <span>
                {m.name} <span className="text-muted">· {m.email}</span>
              </span>
              <Badge>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </Card>
      <EmptyState
        title="No events yet"
        description="Event creation from the dashboard is coming next. The API already supports it."
      />
    </div>
  );
}
