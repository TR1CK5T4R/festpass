'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { OrgsProvider, useOrgs } from '@/lib/orgs';

/**
 * Everything under /dashboard needs a logged-in user. This only decides what to render; the real
 * protection is the API, which rejects every request without a valid access token.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === 'anonymous') router.replace('/login');
  }, [auth.status, router]);

  // Wait for the silent refresh to answer before deciding; otherwise a reload would flash the login page.
  if (auth.status !== 'authenticated') {
    return (
      <p className="p-8 text-sm text-muted" role="status">
        Loading…
      </p>
    );
  }

  return (
    <OrgsProvider>
      <div className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
            <Link href="/dashboard" className="text-lg font-bold tracking-tight">
              FestPass
            </Link>
            <OrgSwitcher />
            <Nav />
            <span className="ml-auto text-sm text-muted">{auth.user.name}</span>
            <Button variant="ghost" onClick={() => void api.logout()}>
              Log out
            </Button>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </div>
    </OrgsProvider>
  );
}

const tabs = [
  { href: '/dashboard', label: 'Events' },
  { href: '/dashboard/members', label: 'Members' },
];

function Nav() {
  const pathname = usePathname();
  const { current } = useOrgs();
  if (!current) return null;
  // Event pages live under /dashboard/orgs/..., and they belong to the Events tab.
  const active = pathname.startsWith('/dashboard/members') ? '/dashboard/members' : '/dashboard';
  return (
    <nav aria-label="Dashboard" className="flex gap-1">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active === t.href ? 'page' : undefined}
          className={`rounded-control px-3 py-1.5 text-sm ${active === t.href ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted hover:text-ink'}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function OrgSwitcher() {
  const { orgs, current, select } = useOrgs();
  if (!orgs || orgs.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Current club</span>
      <select
        value={current?.id}
        onChange={(e) => select(e.target.value)}
        className="rounded-control border border-line bg-surface px-2 py-1.5 text-sm"
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      <Link href="/dashboard/orgs/new" className="text-brand-600 hover:underline">
        + New club
      </Link>
    </label>
  );
}
