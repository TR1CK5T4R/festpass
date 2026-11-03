import { Router } from 'express';
import { healthController } from './controller.js';
import type { ReadinessChecks } from './service.js';

export function healthRoutes(checks: ReadinessChecks): Router {
  const controller = healthController(checks);
  const router = Router();
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
