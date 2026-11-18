import type { RequestHandler } from 'express';
import * as webhooks from './service.js';

export const razorpay: RequestHandler = async (req, res) => {
  // express.raw left the body as the exact bytes Razorpay sent: what the signature covers.
  const result = await webhooks.handleRazorpayWebhook(
    // No body at all leaves {} instead of a Buffer: verify it as empty bytes (and fail).
    Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    req.header('x-razorpay-signature'),
    String(req.id),
  );
  res.json(result);
};
