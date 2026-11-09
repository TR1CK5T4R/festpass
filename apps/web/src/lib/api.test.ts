import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api';

const user = {
  id: 'u1',
  email: 'asha@mait.ac.in',
  name: 'Asha',
  college: null,
  branch: null,
  graduationYear: null,
  createdAt: '2026-11-01T00:00:00.000Z',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unauthorized = () =>
  json(401, {
    error: { code: 'INVALID_ACCESS_TOKEN', message: 'expired', details: {}, requestId: 'r1' },
  });

/** A fake API: answers each URL with the given handler and records every call. */
function fakeApi(routes: Record<string, (init: RequestInit) => Response>) {
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = String(url).replace('http://api.test', '');
    const handler = routes[path];
    if (!handler) throw new Error(`unexpected request to ${path}`);
    return handler(init);
  });
  const client = createApiClient({
    baseUrl: 'http://api.test',
    fetch: fetch as typeof globalThis.fetch,
  });
  const calls = () => fetch.mock.calls.map(([url]) => String(url).replace('http://api.test', ''));
  const authHeader = (i: number) =>
    (fetch.mock.calls[i]?.[1]?.headers as Record<string, string>)?.Authorization;
  return { client, calls, authHeader };
}

describe('api client', () => {
  it('on a 401 refreshes once, retries with the new token and returns the data', async () => {
    let meCalls = 0;
    const { client, calls, authHeader } = fakeApi({
      '/orgs/mine': () => (++meCalls === 1 ? unauthorized() : json(200, { orgs: [] })),
      '/auth/refresh': () => json(200, { user, accessToken: 'fresh-token' }),
    });

    await expect(client.request('/orgs/mine')).resolves.toEqual({ orgs: [] });
    expect(calls()).toEqual(['/orgs/mine', '/auth/refresh', '/orgs/mine']);
    expect(authHeader(2)).toBe('Bearer fresh-token');
  });

  it('does not loop when the retried request is still 401', async () => {
    const { client, calls } = fakeApi({
      '/orgs/mine': unauthorized,
      '/auth/refresh': () => json(200, { user, accessToken: 'fresh-token' }),
    });

    await expect(client.request('/orgs/mine')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_ACCESS_TOKEN',
    });
    expect(calls()).toEqual(['/orgs/mine', '/auth/refresh', '/orgs/mine']);
  });

  it('gives up without retrying when the refresh itself fails, and reports the logout', async () => {
    const { client, calls } = fakeApi({
      '/orgs/mine': unauthorized,
      '/auth/refresh': () => json(401, { error: { code: 'REFRESH_TOKEN_REUSED', message: '' } }),
    });
    const sessions: unknown[] = [];
    client.onSessionChange((s) => sessions.push(s));

    await expect(client.request('/orgs/mine')).rejects.toBeInstanceOf(ApiError);
    expect(calls()).toEqual(['/orgs/mine', '/auth/refresh']);
    expect(sessions).toEqual([null]);
  });

  it('shares one refresh between requests that fail at the same time', async () => {
    // Both endpoints reject requests without a token, so both start a refresh at once.
    const needsToken = (init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization ? json(200, {}) : unauthorized();
    const { client, calls } = fakeApi({
      '/a': needsToken,
      '/b': needsToken,
      '/auth/refresh': () => json(200, { user, accessToken: 'fresh-token' }),
    });

    await Promise.all([client.request('/a'), client.request('/b')]);
    expect(calls().filter((c) => c === '/auth/refresh')).toHaveLength(1);
  });

  it('turns the standard error shape into a typed ApiError', async () => {
    const { client } = fakeApi({
      '/auth/register': () =>
        json(409, {
          error: { code: 'EMAIL_TAKEN', message: 'taken', details: {}, requestId: 'req-9' },
        }),
    });

    const err = await client
      .register({ email: 'a@b.co', password: 'longenough', name: 'A' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'EMAIL_TAKEN', requestId: 'req-9' });
  });
});
