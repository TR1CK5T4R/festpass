'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/form-errors';

// Bull Board is served by the API (e.g. http://localhost:4000/admin/queues), not by this app.
const boardUrl = new URL(
  '/admin/queues',
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
);

/**
 * Opens the job dashboard (Bull Board). A page load can't carry our in-memory access token, so this
 * asks the API for a short-lived admin cookie first; the API only gives one to ADMIN_EMAILS.
 */
export default function QueuesPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.request('/admin/session', { method: 'POST' }).then(
      () => window.location.assign(boardUrl),
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="mb-2 text-xl font-semibold">Job queues</h1>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted" role="status">
          Opening Bull Board…
        </p>
      )}
    </Card>
  );
}
