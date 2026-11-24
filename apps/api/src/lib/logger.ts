import { pino } from 'pino';
import { env } from '../config/env.js';

// Anything here that proves who someone is. A request log line includes every header it was sent.
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admission-token"]',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  // Credentials must never reach the logs: these headers are replaced with "[Redacted]".
  redact: LOG_REDACT_PATHS,
});
