import type { CheckinAnalyticsQuery } from '@festpass/shared';
import type { RequestHandler } from 'express';
import * as analytics from './service.js';

export const sales: RequestHandler = async (req, res) => {
  res.json({ sales: await analytics.sales(req.membership!.orgId, String(req.params.eventId)) });
};

export const checkins: RequestHandler = async (req, res) => {
  const { bucket } = req.query as unknown as CheckinAnalyticsQuery;
  res.json({
    checkins: await analytics.checkins(req.membership!.orgId, String(req.params.eventId), bucket),
  });
};
