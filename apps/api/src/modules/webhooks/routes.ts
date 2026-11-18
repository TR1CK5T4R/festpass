import express, { Router } from 'express';
import * as controller from './controller.js';

/**
 * Mounted at /api/v1/webhooks, *before* the app-wide express.json(): this route needs the raw bytes
 * for the signature check, and a JSON parser would have consumed and re-shaped them.
 */
export function webhookRoutes(): Router {
  const router = Router();
  router.post('/razorpay', express.raw({ type: () => true, limit: '1mb' }), controller.razorpay);
  return router;
}
