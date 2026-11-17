'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * Booking and checkout need a logged-in buyer. A logged-out visitor is sent to log in and comes back
 * to the same page (?next=). The API is still the real check: every request carries the token.
 */
export default function BuyerLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (auth.status === 'anonymous') {
      const here = pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
  }, [auth.status, pathname, router]);

  if (auth.status !== 'authenticated') {
    return (
      <p className="p-8 text-sm text-muted" role="status">
        Loading…
      </p>
    );
  }
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3">
          <Link href="/" className="text-lg font-bold tracking-tight">
            FestPass
          </Link>
          <span className="ml-auto text-sm text-muted">{auth.user.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Suspense>{children}</Suspense>
      </main>
    </div>
  );
}
