import { pingMongo, pingPostgres, pingRedis } from './repository.js';

export type DependencyCheck = () => Promise<void>;
export type ReadinessChecks = Record<string, DependencyCheck>;
export type DependencyStatus = 'up' | 'down';

export const defaultReadinessChecks: ReadinessChecks = {
  postgres: pingPostgres,
  redis: pingRedis,
  mongo: pingMongo,
};

// A dependency that hangs is as bad as one that is down, and the load balancer won't wait long either.
const CHECK_TIMEOUT_MS = 1_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface ReadinessResult {
  ok: boolean;
  checks: Record<string, DependencyStatus>;
  /** Why each failed check failed; for logs only, never sent to the client. */
  failures: Record<string, string>;
}

/** Runs every check in parallel, so readiness takes as long as the slowest check, not the sum. */
export async function checkReadiness(checks: ReadinessChecks): Promise<ReadinessResult> {
  const names = Object.keys(checks);
  const results = await Promise.allSettled(
    names.map((name) => withTimeout(checks[name]!(), CHECK_TIMEOUT_MS)),
  );

  const result: ReadinessResult = { ok: true, checks: {}, failures: {} };
  results.forEach((outcome, i) => {
    const name = names[i]!;
    result.checks[name] = outcome.status === 'fulfilled' ? 'up' : 'down';
    if (outcome.status === 'rejected') {
      result.ok = false;
      result.failures[name] = String((outcome.reason as Error)?.message ?? outcome.reason);
    }
  });
  return result;
}
