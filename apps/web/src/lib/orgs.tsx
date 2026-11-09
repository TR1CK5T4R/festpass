'use client';

import type { OrgSummary } from '@festpass/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

interface OrgsState {
  orgs: OrgSummary[] | null;
  current: OrgSummary | null;
  select: (orgId: string) => void;
  /** Re-fetches /orgs/mine (after creating an org) and optionally selects one. */
  reload: (selectId?: string) => Promise<void>;
}

const OrgsContext = createContext<OrgsState | null>(null);

/** The clubs the user belongs to and which one the dashboard is showing. */
export function OrgsProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async (selectId?: string) => {
    const res = await api.request<{ orgs: OrgSummary[] }>('/orgs/mine');
    setOrgs(res.orgs);
    if (selectId) setSelectedId(selectId);
  }, []);

  useEffect(() => {
    let active = true;
    void api.request<{ orgs: OrgSummary[] }>('/orgs/mine').then((res) => {
      if (active) setOrgs(res.orgs);
    });
    return () => {
      active = false;
    };
  }, []);

  const current = orgs?.find((o) => o.id === selectedId) ?? orgs?.[0] ?? null;
  return (
    <OrgsContext.Provider value={{ orgs, current, select: setSelectedId, reload }}>
      {children}
    </OrgsContext.Provider>
  );
}

export function useOrgs(): OrgsState {
  const state = useContext(OrgsContext);
  if (!state) throw new Error('useOrgs must be used inside OrgsProvider');
  return state;
}
