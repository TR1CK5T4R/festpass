import type { RequestHandler } from 'express';
import * as payments from './service.js';

export const pay: RequestHandler = async (req, res) => {
  res.json({ payment: await payments.startPayment(req.user!.id, String(req.params.orderId)) });
};
