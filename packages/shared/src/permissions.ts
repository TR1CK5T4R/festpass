// Who can do what inside an organization, as data. The API enforces it (requireOrgPermission) and the
// web app reads the same table to decide which buttons to show, so the two can never disagree.

export const ORG_ROLES = ['OWNER', 'MANAGER', 'SCANNER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_ACTIONS = [
  'org:read',
  'member:manage',
  'event:create',
  'event:update',
  'event:publish',
  'checkin:scan',
] as const;
export type OrgAction = (typeof ORG_ACTIONS)[number];

export const PERMISSIONS: Record<OrgRole, readonly OrgAction[]> = {
  OWNER: ORG_ACTIONS,
  MANAGER: ['org:read', 'event:create', 'event:update', 'event:publish', 'checkin:scan'],
  // Gate volunteers: they see which org they scan for, and scan. Nothing else.
  SCANNER: ['org:read', 'checkin:scan'],
};

export function can(role: OrgRole, action: OrgAction): boolean {
  return PERMISSIONS[role].includes(action);
}
