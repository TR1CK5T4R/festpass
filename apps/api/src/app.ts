import express from 'express';
import { env } from './config/env.js';
import { cors } from './middleware/cors.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import type { Limit } from './lib/rate-limit.js';
import { requestLogger } from './middleware/request-logger.js';
import { authRoutes } from './modules/auth/routes.js';
import { orgEventRoutes, publicEventRoutes } from './modules/events/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { adminApiRoutes, queueDashboard } from './modules/admin/routes.js';
import { orderActionRoutes, orderRoutes } from './modules/orders/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { orgRoutes } from './modules/orgs/routes.js';
import { myTicketRoutes, ticketRoutes } from './modules/tickets/routes.js';
import { uploadRoutes } from './modules/uploads/routes.js';
import { webhookRoutes } from './modules/webhooks/routes.js';
import { defaultReadinessChecks, type ReadinessChecks } from './modules/health/service.js';

export interface AppDeps {
  /** Tests pass fake checks to simulate a dependency being down. */
  readinessChecks?: ReadinessChecks;
  /** Tests pass small limits to see throttling without changing the env for every other suite. */
  rateLimits?: Partial<RateLimits>;
}

export interface RateLimits {
  login: Limit;
  register: Limit;
  orders: Limit;
  presign: Limit;
}

// Building the app separately from listening lets tests call it with Supertest
// without opening a real port.
export function createApp({ readinessChecks = defaultReadinessChecks, rateLimits }: AppDeps = {}) {
  const limits: RateLimits = {
    login: env.RATE_LIMIT_LOGIN,
    register: env.RATE_LIMIT_REGISTER,
    orders: env.RATE_LIMIT_ORDERS,
    presign: env.RATE_LIMIT_PRESIGN,
    ...rateLimits,
  };
  const app = express();
  app.disable('x-powered-by');

  // First, so every later log line and error response carries the request ID.
  app.use(requestLogger);
  app.use(cors(env.WEB_ORIGINS));
  // Webhooks first: they need the raw body, which express.json() below would consume.
  app.use('/api/v1/webhooks', webhookRoutes());
  app.use(express.json());

  app.use('/api/v1/health', healthRoutes(readinessChecks));
  app.use('/api/v1/auth', authRoutes(limits));
  app.use('/api/v1/orgs/:orgId/events', orgEventRoutes());
  app.use('/api/v1/orgs', orgRoutes());
  app.use('/api/v1/events/:eventId/orders', orderRoutes(limits.orders));
  app.use('/api/v1/orders', orderActionRoutes());
  app.use('/api/v1/orders', paymentRoutes());
  app.use('/api/v1/me/tickets', myTicketRoutes());
  app.use('/api/v1/tickets', ticketRoutes());
  app.use('/api/v1/admin', adminApiRoutes());
  app.use('/admin/queues', queueDashboard());
  app.use('/api/v1/events', publicEventRoutes());
  app.use('/api/v1/uploads', uploadRoutes(limits.presign));

  // Last: unmatched routes become a 404, then every error is rendered in the standard shape.
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
