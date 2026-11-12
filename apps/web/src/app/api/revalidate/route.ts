import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { revalidateEventSchema } from '@festpass/shared';
import { revalidatePath } from 'next/cache';

const digest = (value: string) => createHash('sha256').update(value).digest();

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message, details: {}, requestId: randomUUID() } }, { status });

/**
 * POST /api/revalidate with `Authorization: Bearer <REVALIDATE_SECRET>` and `{ "slug": "..." }`.
 * Called by the API (never by browsers) after a public event changes. It marks the event page and the
 * home list as stale, so the next visitor gets a freshly rendered page instead of waiting up to 60 s.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  const given = request.headers.get('authorization') ?? '';
  // Hashed to equal length and compared in constant time, so timing can't reveal a partial match.
  if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return fail(401, 'UNAUTHORIZED', 'Missing or wrong revalidation secret');
  }

  const body = revalidateEventSchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return fail(400, 'VALIDATION_FAILED', 'Body must be { "slug": "<event-slug>" }');

  const paths = [`/e/${body.data.slug}`, '/'];
  for (const path of paths) revalidatePath(path);
  return Response.json({ revalidated: paths });
}
