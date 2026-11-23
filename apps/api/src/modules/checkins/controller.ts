import type { BatchCheckinInput, CheckinInput } from '@festpass/shared';
import type { RequestHandler } from 'express';
import { AppError, ConflictError } from '../../lib/errors.js';
import * as checkins from './service.js';

export const checkIn: RequestHandler = async (req, res) => {
  const outcome = await checkins.checkIn(
    String(req.params.eventId),
    req.user!.id,
    req.body as CheckinInput,
  );
  switch (outcome.result) {
    case 'ACCEPTED':
      res.json({ result: outcome.result, ticket: outcome.ticket });
      return;
    case 'DUPLICATE':
      throw new ConflictError('ALREADY_CHECKED_IN', 'This ticket has already been scanned', {
        ticketId: outcome.ticketId,
        firstScannedAt: outcome.firstScannedAt,
        firstScannedBy: outcome.firstScannedBy,
      });
    default:
      // A QR that isn't ours is a bad request; a genuine one that doesn't apply here is a conflict.
      throw outcome.code === 'INVALID_QR'
        ? new AppError(400, outcome.code, outcome.message)
        : new ConflictError(outcome.code, outcome.message);
  }
};

export const batch: RequestHandler = async (req, res) => {
  const results = await checkins.checkInBatch(
    String(req.params.eventId),
    req.user!.id,
    req.body as BatchCheckinInput,
  );
  res.json({ results });
};

export const manifest: RequestHandler = async (req, res) => {
  res.json({ manifest: await checkins.gateManifest(String(req.params.eventId)) });
};

export const summary: RequestHandler = async (req, res) => {
  res.json({ summary: await checkins.checkinSummary(String(req.params.eventId)) });
};
