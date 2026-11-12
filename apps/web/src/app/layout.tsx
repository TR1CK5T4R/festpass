import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  // Pages set only their own part ("HackMAIT 2026") and get "· FestPass" added.
  title: { default: 'FestPass', template: '%s · FestPass' },
  description: 'Flash-sale-safe ticketing and entry for college fests.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
