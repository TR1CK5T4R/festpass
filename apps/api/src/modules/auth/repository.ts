import { prisma, Prisma } from '@festpass/db';
import type { RegisterInput } from '@festpass/shared';

// Every query that returns a user to the service selects these columns only, so the password hash
// can't leak into a response by accident. The one exception is findUserForLogin.
const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  college: true,
  branch: true,
  graduationYear: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

/** Returns null if the email is already registered (unique violation), so concurrent sign-ups can't both win. */
export async function createUser(
  input: Omit<RegisterInput, 'password'> & { passwordHash: string },
): Promise<UserRecord | null> {
  try {
    return await prisma.user.create({ data: input, select: publicUserSelect });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export function findUserForLogin(email: string) {
  return prisma.user.findUnique({
    where: { email },
    select: { ...publicUserSelect, passwordHash: true },
  });
}

export function findUserById(id: string): Promise<UserRecord | null> {
  return prisma.user.findUnique({ where: { id }, select: publicUserSelect });
}

export function createRefreshToken(data: {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}) {
  return prisma.refreshToken.create({ data });
}

export function findRefreshToken(tokenHash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash } });
}

/**
 * Revokes the old token and stores its replacement in one transaction. The revoke is guarded by
 * `revoked_at IS NULL`, so if two requests rotate the same token at once only one succeeds;
 * the other gets false and is treated as reuse.
 */
export async function rotateRefreshToken(
  oldId: string,
  next: { userId: string; tokenHash: string; familyId: string; expiresAt: Date },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.refreshToken.updateMany({
      where: { id: oldId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return false;
    await tx.refreshToken.create({ data: next });
    return true;
  });
}

export async function revokeFamily(familyId: string): Promise<number> {
  const { count } = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}
