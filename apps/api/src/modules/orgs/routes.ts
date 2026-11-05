import {
  addMemberSchema,
  createOrgSchema,
  memberParamsSchema,
  orgParamsSchema,
  updateMemberSchema,
} from '@festpass/shared';
import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOrgPermission } from '../../middleware/require-org-permission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

// Order on org routes: params are checked first (orgId must be a UUID), then membership and
// permission, and only then the body, so a non-member learns nothing from validation errors.
export function orgRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/', validate({ body: createOrgSchema }), controller.create);
  router.get('/mine', controller.mine);
  router.get(
    '/:orgId',
    validate({ params: orgParamsSchema }),
    requireOrgPermission('org:read'),
    controller.get,
  );
  router.post(
    '/:orgId/members',
    validate({ params: orgParamsSchema }),
    requireOrgPermission('member:manage'),
    validate({ body: addMemberSchema }),
    controller.addMember,
  );
  router.patch(
    '/:orgId/members/:userId',
    validate({ params: memberParamsSchema }),
    requireOrgPermission('member:manage'),
    validate({ body: updateMemberSchema }),
    controller.updateMember,
  );
  router.delete(
    '/:orgId/members/:userId',
    validate({ params: memberParamsSchema }),
    requireOrgPermission('member:manage'),
    controller.removeMember,
  );
  return router;
}
