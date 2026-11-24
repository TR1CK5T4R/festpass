import type { RequestHandler } from 'express';
import * as queue from './service.js';

export const join: RequestHandler = async (req, res) => {
  res.json(await queue.join(String(req.params.eventId), req.user!.id));
};

export const status: RequestHandler = async (req, res) => {
  res.json(await queue.status(String(req.params.eventId), req.user!.id));
};
