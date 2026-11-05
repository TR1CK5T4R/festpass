import type { RequestHandler } from 'express';
import * as orgs from './service.js';

// req.user and req.membership are set by requireAuth and requireOrgPermission in routes.ts.

export const create: RequestHandler = async (req, res) => {
  res.status(201).json({ org: await orgs.createOrg(req.user!.id, req.body) });
};

export const mine: RequestHandler = async (req, res) => {
  res.json({ orgs: await orgs.listMyOrgs(req.user!.id) });
};

export const get: RequestHandler = async (req, res) => {
  const { orgId, role } = req.membership!;
  res.json(await orgs.getOrg(orgId, role));
};

export const addMember: RequestHandler = async (req, res) => {
  res.status(201).json({ member: await orgs.addMember(req.membership!.orgId, req.body) });
};

export const updateMember: RequestHandler = async (req, res) => {
  const member = await orgs.updateMemberRole(
    req.membership!.orgId,
    String(req.params.userId),
    req.body.role,
  );
  res.json({ member });
};

export const removeMember: RequestHandler = async (req, res) => {
  await orgs.removeMember(req.membership!.orgId, String(req.params.userId));
  res.status(204).end();
};
