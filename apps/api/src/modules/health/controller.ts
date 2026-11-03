import type { RequestHandler } from 'express';
import { checkReadiness, type ReadinessChecks } from './service.js';

export function healthController(checks: ReadinessChecks) {
  /** Liveness: the process is running and can answer. Deliberately checks nothing else. */
  const live: RequestHandler = (_req, res) => {
    res.json({ status: 'ok' });
  };

  /** Readiness: every dependency answers, so this instance can serve real traffic. */
  const ready: RequestHandler = async (req, res) => {
    const result = await checkReadiness(checks);
    if (!result.ok) req.log.warn({ failures: result.failures }, 'readiness check failed');
    res
      .status(result.ok ? 200 : 503)
      .json({ status: result.ok ? 'ok' : 'unavailable', checks: result.checks });
  };

  return { live, ready };
}
