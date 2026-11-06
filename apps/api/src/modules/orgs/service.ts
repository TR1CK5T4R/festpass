import type {
  AddMemberInput,
  CreateOrgInput,
  OrgMemberView,
  OrgRole,
  OrgSummary,
} from '@festpass/shared';
import { bodyFieldErrors, ConflictError, NotFoundError } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import * as repo from './repository.js';

export async function createOrg(userId: string, input: CreateOrgInput): Promise<OrgSummary> {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 3) {
    throw bodyFieldErrors([{ path: 'slug', message: 'Choose a slug of at least 3 characters' }]);
  }
  const org = await repo.createOrgWithOwner({ name: input.name, slug }, userId);
  if (!org) throw new ConflictError('SLUG_TAKEN', 'An organization with this slug already exists');
  return { ...org, role: 'OWNER' };
}

export async function listMyOrgs(userId: string): Promise<OrgSummary[]> {
  const memberships = await repo.listMemberships(userId);
  return memberships.map((m) => ({ ...m.org, role: m.role }));
}

export async function getOrg(orgId: string, role: OrgRole) {
  // requireOrgPermission already proved the caller is a member, so the org exists.
  const org = (await repo.findOrgWithMembers(orgId))!;
  const members: OrgMemberView[] = org.members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
  }));
  return { org: { id: org.id, name: org.name, slug: org.slug, role }, members };
}

export async function addMember(orgId: string, input: AddMemberInput) {
  const user = await repo.findUserIdByEmail(input.email);
  // Only owners reach this, and they need to know whether to ask the person to sign up first.
  if (!user)
    throw new NotFoundError('No FestPass account uses this email; ask them to sign up first');
  const member = await repo.addMember(orgId, user.id, input.role);
  if (!member) throw new ConflictError('ALREADY_MEMBER', 'This user is already a member');
  return { userId: user.id, role: member.role };
}

async function change(orgId: string, userId: string, role: OrgRole | null) {
  const result = await repo.changeMembership(orgId, userId, role);
  if (result === 'NOT_MEMBER') throw new NotFoundError('Member not found');
  if (result === 'LAST_OWNER') {
    throw new ConflictError('LAST_OWNER', 'An organization must keep at least one owner');
  }
}

export async function updateMemberRole(orgId: string, userId: string, role: OrgRole) {
  await change(orgId, userId, role);
  return { userId, role };
}

export function removeMember(orgId: string, userId: string) {
  return change(orgId, userId, null);
}
