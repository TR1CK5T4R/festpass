import type { BoothScanInput, CreateBoothInput, CreateSponsorInput } from '@festpass/shared';
import type { Request, RequestHandler } from 'express';
import * as sponsors from './service.js';

const ids = (req: Request) => ({
  orgId: req.membership!.orgId,
  eventId: String(req.params.eventId),
  sponsorId: String(req.params.sponsorId),
});

export const list: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.json({ sponsors: await sponsors.listSponsors(orgId, eventId) });
};

export const create: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.status(201).json({
    sponsor: await sponsors.createSponsor(orgId, eventId, req.body as CreateSponsorInput),
  });
};

export const createBooth: RequestHandler = async (req, res) => {
  const { orgId, eventId, sponsorId } = ids(req);
  const { name } = req.body as CreateBoothInput;
  res.status(201).json({ booth: await sponsors.createBooth(orgId, eventId, sponsorId, name) });
};

export const addMember: RequestHandler = async (req, res) => {
  const { orgId, eventId, sponsorId } = ids(req);
  const { email } = req.body as { email: string };
  res.status(201).json({ sponsor: await sponsors.addMember(orgId, eventId, sponsorId, email) });
};

export const removeMember: RequestHandler = async (req, res) => {
  const { orgId, eventId, sponsorId } = ids(req);
  await sponsors.removeMember(orgId, eventId, sponsorId, String(req.params.userId));
  res.status(204).end();
};

export const booths: RequestHandler = async (req, res) => {
  res.json({ booths: await sponsors.listBooths(String(req.params.eventId)) });
};

export const boothScan: RequestHandler = async (req, res) => {
  const visit = await sponsors.boothScan(
    String(req.params.boothId),
    req.user!.id,
    req.body as BoothScanInput,
  );
  res.status(201).json({ visit });
};

export const mine: RequestHandler = async (req, res) => {
  res.json({ sponsorships: await sponsors.mySponsorships(req.user!.id) });
};

export const analytics: RequestHandler = async (req, res) => {
  res.json({
    analytics: await sponsors.analyticsFor(req.user!.id, String(req.params.sponsorId)),
  });
};
