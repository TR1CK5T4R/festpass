import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      {action}
    </div>
  );
}
