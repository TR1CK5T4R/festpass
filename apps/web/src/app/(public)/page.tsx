import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-5xl font-bold tracking-tight">FestPass</h1>
      <p className="max-w-md text-lg text-muted">
        Ticketing and entry for college fests, built to stay correct when the whole campus books at
        once.
      </p>
      <div className="flex gap-3">
        <Link
          href="/register"
          className="rounded-control bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Create an account
        </Link>
        <Link
          href="/login"
          className="rounded-control border border-line bg-surface px-5 py-2.5 text-sm font-medium hover:bg-canvas"
        >
          Log in
        </Link>
      </div>
    </main>
  );
}
