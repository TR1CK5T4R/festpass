import { can, type OrgAction, type OrgRole } from '@festpass/shared';
import type { RequestHandler } from 'express';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { findMembership } from '../modules/orgs/repository.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireOrgPermission: the caller's role in the org named by :orgId. */
      membership?: { orgId: string; role: OrgRole };
    }
  }
}

/**
 * Mount after requireAuth and after :orgId has been validated as a UUID.
 * Not a member: 404, the same answer as for an org that doesn't exist, so IDs can't be probed.
 * Member without the permission: 403, because they already know the org exists.
 */
export function requireOrgPermission(action: OrgAction): RequestHandler {
  return async (req, _res, next) => {
    const orgId = String(req.params.orgId);
    const membership = await findMembership(orgId, req.user!.id);
    if (!membership) return next(new NotFoundError('Organization not found'));
    if (!can(membership.role, action)) return next(new ForbiddenError());
    req.membership = { orgId, role: membership.role };
    next();
  };
}
