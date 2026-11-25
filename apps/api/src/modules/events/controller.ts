import type { PublicEventsQuery } from '@festpass/shared';
import type { Request, RequestHandler } from 'express';
import * as events from './service.js';

// Route params are validated (UUIDs) and membership is checked by requireOrgPermission before these run.
const ids = (req: Request) => ({
  orgId: req.membership!.orgId,
  eventId: String(req.params.eventId),
  tierId: String(req.params.tierId),
});

export const create: RequestHandler = async (req, res) => {
  res.status(201).json({ event: await events.createEvent(req.membership!.orgId, req.body) });
};

export const list: RequestHandler = async (req, res) => {
  const { cursor, limit } = req.query as unknown as PublicEventsQuery;
  res.json(await events.listOrgEvents(req.membership!.orgId, cursor, limit));
};

export const get: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.json({ event: await events.getEvent(orgId, eventId) });
};

export const update: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.json({ event: await events.updateEvent(orgId, eventId, req.body) });
};

export const publish: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.json({ event: await events.publishEvent(orgId, eventId) });
};

export const close: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.json({ event: await events.closeEvent(orgId, eventId) });
};

export const createTier: RequestHandler = async (req, res) => {
  const { orgId, eventId } = ids(req);
  res.status(201).json({ tier: await events.createTier(orgId, eventId, req.body) });
};

export const updateTier: RequestHandler = async (req, res) => {
  const { orgId, eventId, tierId } = ids(req);
  res.json({ tier: await events.updateTier(orgId, eventId, tierId, req.body) });
};

export const deleteTier: RequestHandler = async (req, res) => {
  const { orgId, eventId, tierId } = ids(req);
  await events.deleteTier(orgId, eventId, tierId);
  res.status(204).end();
};

// Browsers and CDNs may reuse a public answer briefly; availability makes anything longer misleading.
// Each answer also gets an ETag from Express, so a repeat request with nothing new is a 304 with no body.
const PUBLIC_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=25';

export const listPublic: RequestHandler = async (req, res) => {
  res.set('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.json(await events.listPublicEvents(req.query as unknown as PublicEventsQuery));
};

export const getPublic: RequestHandler = async (req, res) => {
  const event = await events.getPublicEvent(String(req.params.slug));
  // Set only once found: a 404 must not be cached, or a just-published event would look missing.
  res.set('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.json({ event });
};
