import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger.js';

// Short IDs of letters, digits, '_' and '-' only, so a caller can't inject newlines or huge strings into our logs.
const SAFE_REQUEST_ID = /^[\w-]{1,64}$/;

/** Logs every request and gives it an ID (req.id) that appears in every log line and in the X-Request-Id header. */
export const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    // Reuse an incoming ID (e.g. from a load balancer or the web app) so one request can be traced across services.
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
