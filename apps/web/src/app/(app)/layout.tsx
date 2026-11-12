import type { ReactNode } from 'react';
import { Providers } from '../providers';

// Login, register and the dashboard share the auth client and toasts. Public event pages sit outside
// this group, so they ship none of it and never call /auth/refresh on load.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
