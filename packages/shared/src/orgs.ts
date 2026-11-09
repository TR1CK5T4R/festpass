import { z } from 'zod';
import { ORG_ROLES, type OrgRole } from './permissions.ts';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens')
  .min(3)
  .max(60);

/** slug is optional: the API derives it from the name when it's missing. */
export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slug.optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const orgParamsSchema = z.object({ orgId: z.uuid() });
export const memberParamsSchema = z.object({ orgId: z.uuid(), userId: z.uuid() });

const role = z.enum(ORG_ROLES);

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role,
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role });

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  /** The caller's role in this org. */
  role: OrgRole;
}

export interface OrgMemberView {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
}
