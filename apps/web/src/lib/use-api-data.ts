'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * GETs `path` and keeps the result. `reload()` fetches again after a change; `setData` puts a fresh
 * server response in place without a round trip. Pass null to wait (e.g. until the club is known).
 */
export function useApiData<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: unknown }>({
    path: null,
    data: null,
    error: null,
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) return;
    let active = true;
    api.request<T>(path).then(
      (data) => active && setState({ path, data, error: null }),
      (error: unknown) => active && setState({ path, data: null, error }),
    );
    return () => {
      active = false;
    };
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback((data: T) => setState({ path, data, error: null }), [path]);
  // After switching clubs, the previous club's data must never show under the new name.
  const fresh = state.path === path;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, reload, setData };
}
