import Link from 'next/link';

export default function EventNotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-2xl font-semibold">Event not found</h1>
      <p className="max-w-md text-sm text-muted">
        The link may be wrong, or the organizers haven&apos;t published this event yet.
      </p>
      <Link href="/" className="text-sm font-medium text-brand-600 hover:underline">
        See upcoming events
      </Link>
    </div>
  );
}
