import Link from 'next/link';
import type { ReactNode } from 'react';

// Public pages are Server Components with no client providers: they ship almost no JavaScript.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <Link href="/" className="text-lg font-bold tracking-tight">
            FestPass
          </Link>
          <Link href="/dashboard" className="ml-auto text-sm text-muted hover:text-ink">
            For organizers
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        FestPass: ticketing and entry for college fests
      </footer>
    </div>
  );
}
