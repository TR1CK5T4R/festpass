'use client';

import type { PublicUser } from '@festpass/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: PublicUser };

const AuthContext = createContext<AuthState | null>(null);

/**
 * Knows who is logged in. On every page load the access token is gone (it only lived in memory), so
 * the first thing this does is a silent refresh: POST /auth/refresh with the httpOnly cookie the browser
 * still has. Success means "logged in" without the user doing anything; failure means "anonymous".
 * Until that answer arrives the status is "loading", so protected pages don't redirect too early.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

  useEffect(() => {
    const unsubscribe = api.onSessionChange((session) =>
      setState(
        session
          ? { status: 'authenticated', user: session.user }
          : { status: 'anonymous', user: null },
      ),
    );
    void api.refresh();
    return () => {
      unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error('useAuth must be used inside AuthProvider');
  return state;
}
