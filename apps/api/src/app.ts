import express from 'express';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { defaultReadinessChecks, type ReadinessChecks } from './modules/health/service.js';

export interface AppDeps {
  /** Tests pass fake checks to simulate a dependency being down. */
  readinessChecks?: ReadinessChecks;
}

// Building the app separately from listening lets tests call it with Supertest
// without opening a real port.
export function createApp({ readinessChecks = defaultReadinessChecks }: AppDeps = {}) {
  const app = express();
  app.disable('x-powered-by');

  // First, so every later log line and error response carries the request ID.
  app.use(requestLogger);
  app.use(express.json());

  app.use('/api/v1/health', healthRoutes(readinessChecks));
  app.use('/api/v1/auth', authRoutes());

  // Last: unmatched routes become a 404, then every error is rendered in the standard shape.
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
