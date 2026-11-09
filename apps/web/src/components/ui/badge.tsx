import type { ReactNode } from 'react';

const tones = {
  neutral: 'bg-canvas text-muted border-line',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
  success: 'bg-success/10 text-success border-success/20',
};

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
