'use client';

// Only reached when there is no cached copy to serve: if a background rebuild fails, ISR keeps
// serving the last good page instead.
export default function PublicError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold">We couldn&apos;t load this page</h1>
      <p className="text-sm text-muted">
        The event service didn&apos;t answer. Try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-control border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-canvas"
      >
        Try again
      </button>
    </div>
  );
}
