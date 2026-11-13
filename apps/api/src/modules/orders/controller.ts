import type { RequestHandler } from 'express';
import { AppError } from '../../lib/errors.js';
import * as orders from './service.js';

export const create: RequestHandler = async (req, res) => {
  const { answer, replayed } = await orders.createOrder(
    req.user!.id,
    String(req.params.eventId),
    String(req.header('idempotency-key')),
    req.body,
  );
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  // Stored rejections (SOLD_OUT, PER_USER_LIMIT) go through the error handler like any other error,
  // so they get the standard shape and this request's ID.
  if (answer.status !== 201) {
    const { code, message, details } = answer.body;
    throw new AppError(answer.status, code, message, details);
  }
  res.status(201).json(answer.body);
};
