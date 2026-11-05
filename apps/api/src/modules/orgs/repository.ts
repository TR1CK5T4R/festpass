import { prisma, Prisma } from '@festpass/db';
import type { OrgRole } from '@festpass/shared';

const orgSelect = { id: true, name: true, slug: true } satisfies Prisma.OrganizationSelect;

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export function findMembership(orgId: string, userId: string) {
  return prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  });
}

/** Creates the org and its OWNER membership in one statement (Prisma wraps nested creates in a transaction). Null if the slug is taken. */
export async function createOrgWithOwner(input: { name: string; slug: string }, ownerId: string) {
  try {
    return await prisma.organization.create({
      data: { ...input, members: { create: { userId: ownerId, role: 'OWNER' } } },
      select: orgSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// shortcut: no pagination, a student is in a handful of clubs; switch to cursor pagination if that grows.
export function listMemberships(userId: string) {
  return prisma.orgMember.findMany({
    where: { userId },
    select: { role: true, org: { select: orgSelect } },
    orderBy: { createdAt: 'asc' },
  });
}

export function findOrgWithMembers(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      ...orgSelect,
      members: {
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

export function findUserIdByEmail(email: string) {
  return prisma.user.findUnique({ where: { email }, select: { id: true } });
}

/** Null if the user is already a member (primary key org_id + user_id). */
export async function addMember(orgId: string, userId: string, role: OrgRole) {
  try {
    return await prisma.orgMember.create({ data: { orgId, userId, role }, select: { role: true } });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export type MembershipChange = 'OK' | 'NOT_MEMBER' | 'LAST_OWNER';

/**
 * Changes a member's role, or removes them when newRole is null, without ever leaving the org ownerless.
 * The OWNER rows are locked first (FOR UPDATE), so if two owners demote each other at the same moment,
 * the second transaction waits, then sees only one owner left and is refused.
 */
export function changeMembership(
  orgId: string,
  userId: string,
  newRole: OrgRole | null,
): Promise<MembershipChange> {
  return prisma.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM org_members WHERE org_id = ${orgId}::uuid AND role = 'OWNER' FOR UPDATE`;
    const where = { orgId_userId: { orgId, userId } };
    const target = await tx.orgMember.findUnique({ where, select: { role: true } });
    if (!target) return 'NOT_MEMBER';
    if (target.role === 'OWNER' && newRole !== 'OWNER' && owners.length <= 1) return 'LAST_OWNER';

    if (newRole === null) await tx.orgMember.delete({ where });
    else await tx.orgMember.update({ where, data: { role: newRole } });
    return 'OK';
  });
}
