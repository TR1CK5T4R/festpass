import type { ApiErrorBody, AuthResponse, LoginInput, RegisterInput } from '@festpass/shared';

/** An error response from the API, in the standard shape, as something code can branch on. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

type Session = AuthResponse | null;

export interface ApiClientOptions {
  baseUrl: string;
  /** Injected in tests; the browser's fetch otherwise. */
  fetch?: typeof fetch;
}

/**
 * The only way the web app talks to the API.
 *
 * The access token lives in this closure, in memory only. Not in localStorage: any script that runs on
 * the page (an XSS bug, a compromised npm package) can read localStorage and send the token anywhere,
 * and it would survive the tab closing. Memory dies with the tab, and after a reload the token is
 * re-issued from the httpOnly refresh cookie, which scripts can't read at all.
 */
export function createApiClient({ baseUrl, fetch: fetchFn = globalThis.fetch }: ApiClientOptions) {
  let accessToken: string | null = null;
  let refreshing: Promise<boolean> | null = null;
  const listeners = new Set<(session: Session) => void>();

  function setSession(session: Session) {
    accessToken = session?.accessToken ?? null;
    for (const listener of listeners) listener(session);
  }

  function send(path: string, method: string, body: unknown) {
    return fetchFn(`${baseUrl}${path}`, {
      method,
      // Sends the refresh cookie (scoped to /api/v1/auth) to the API's origin.
      credentials: 'include',
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as T | ApiErrorBody | null;
    if (res.ok) return body as T;
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? `HTTP_${res.status}`,
      error?.message ?? res.statusText,
      error?.details,
      error?.requestId,
    );
  }

  /**
   * Gets a new access token from the refresh cookie. Concurrent callers share one request: the API
   * rotates the refresh token on every use and treats a second use as theft, so two parallel refreshes
   * from the same tab would log the user out.
   */
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const res = await send('/auth/refresh', 'POST', undefined);
        setSession(res.ok ? ((await res.json()) as AuthResponse) : null);
        return res.ok;
      } catch {
        setSession(null);
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
    const method = init.method ?? 'GET';
    let res = await send(path, method, init.body);
    // Access tokens expire after 15 minutes: refresh once and retry once. If the retry is also a 401
    // (or the refresh failed), give up with the error instead of looping. /auth/* calls never retry.
    if (res.status === 401 && !path.startsWith('/auth/') && (await refresh())) {
      res = await send(path, method, init.body);
    }
    return parse<T>(res);
  }

  async function startSession(path: string, body: unknown) {
    const session = await parse<AuthResponse>(await send(path, 'POST', body));
    setSession(session);
    return session;
  }

  return {
    request,
    refresh,
    login: (input: LoginInput) => startSession('/auth/login', input),
    register: (input: RegisterInput) => startSession('/auth/register', input),
    async logout() {
      try {
        await send('/auth/logout', 'POST', undefined);
      } finally {
        setSession(null);
      }
    },
    /** Called with the new session (or null) whenever login, refresh or logout changes it. */
    onSessionChange(listener: (session: Session) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The app-wide client. One instance, so all requests share the token and the refresh lock. */
export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1',
});
