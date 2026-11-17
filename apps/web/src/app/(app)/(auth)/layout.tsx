import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-2xl font-bold tracking-tight">
        FestPass
      </Link>
      {/* The forms read ?next= (useSearchParams), which needs a Suspense boundary to prerender. */}
      <div className="w-full max-w-sm">
        <Suspense>{children}</Suspense>
      </div>
    </main>
  );
}
