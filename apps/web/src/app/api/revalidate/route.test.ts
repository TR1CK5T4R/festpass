import { revalidatePath } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const SECRET = 'test-secret-that-is-at-least-32-characters';
process.env.REVALIDATE_SECRET = SECRET;

const call = (body: unknown, authorization?: string) =>
  POST(
    new Request('http://localhost:3000/api/revalidate', {
      method: 'POST',
      headers: authorization ? { authorization } : {},
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => vi.mocked(revalidatePath).mockClear());

describe('POST /api/revalidate', () => {
  it.each([
    ['a wrong secret', `Bearer ${SECRET}x`],
    ['no Authorization header', undefined],
    ['the secret without "Bearer"', SECRET],
  ])('rejects %s with 401 and revalidates nothing', async (_name, auth) => {
    const res = await call({ slug: 'hackmait-2026' }, auth);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('with the right secret, revalidates the event page and the home list', async () => {
    const res = await call({ slug: 'hackmait-2026' }, `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: ['/e/hackmait-2026', '/'] });
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([['/e/hackmait-2026'], ['/']]);
  });

  it('only accepts real slugs, so the secret holder still cannot name other paths', async () => {
    const res = await call({ slug: '../dashboard' }, `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
