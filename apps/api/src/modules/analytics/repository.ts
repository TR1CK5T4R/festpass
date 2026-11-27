import { prisma } from '@festpass/db';

// The sales SQL itself lives in @festpass/db/analytics (with the rest of the raw SQL).
export { salesByDay, tierSales } from '@festpass/db/analytics';

export async function eventBelongsToOrg(orgId: string, eventId: string) {
  const [row] = await prisma.$queryRaw<unknown[]>`
    SELECT 1 FROM events WHERE id = ${eventId}::uuid AND org_id = ${orgId}::uuid`;
  return row !== undefined;
}
