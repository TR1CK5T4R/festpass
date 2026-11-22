import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Scanner', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { themeColor: '#3a54d6' };

export default function ScanLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-4">{children}</main>;
}
