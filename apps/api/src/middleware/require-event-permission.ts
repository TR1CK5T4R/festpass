import { can, type OrgAction } from '@festpass/shared';
import type { RequestHandler } from 'express';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { findEventOrg } from '../modules/events/repository.js';
import { findMembership } from '../modules/orgs/repository.js';

/**
 * requireOrgPermission for routes that name an event instead of an org: the org comes from the event.
 * Mount after requireAuth and after :eventId has been validated. Same answers: no such event or not a
 * member is 404, so IDs can't be probed; a member without the permission is 403.
 */
export function requireEventPermission(action: OrgAction): RequestHandler {
  return async (req, _res, next) => {
    const event = await findEventOrg(String(req.params.eventId));
    const membership = event && (await findMembership(event.orgId, req.user!.id));
    if (!event || !membership) return next(new NotFoundError('Event not found'));
    if (!can(membership.role, action)) return next(new ForbiddenError());
    req.membership = { orgId: event.orgId, role: membership.role };
    next();
  };
}
