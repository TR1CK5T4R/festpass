import { createQueue } from '@festpass/shared/server';
import { QUEUES } from '@festpass/shared';
import { gateRedis } from './redis.js';

// The API only adds jobs (the worker runs them). The fail-fast client is used so that adding a job
// while Redis is down errors at once instead of holding up the request; every job the API adds has a
// safety net that catches it later (the expiry sweeper).
export const ordersQueue = createQueue(QUEUES.orders, gateRedis);
export const inventoryQueue = createQueue(QUEUES.inventory, gateRedis);
