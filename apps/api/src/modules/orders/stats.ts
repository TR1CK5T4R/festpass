import { logger } from '../../lib/logger.js';

/**
 * How bookings ended, counted since the process started: proof that the gate does its job (most
 * refusals should come from Redis, not from a Postgres transaction).
 * shortcut: in-process counters written to the log; real metrics (Prometheus) arrive on Day 28.
 */
export const bookingStats = {
  booked: 0,
  rejectedAtGate: 0,
  rejectedAtPostgres: 0,
  gateSkipped: 0,
  compensated: 0,
};

let lastLogged = '';

/** Logs the counters once a minute, only when they changed. */
export function logBookingStatsEvery(ms: number) {
  return setInterval(() => {
    const snapshot = JSON.stringify(bookingStats);
    if (snapshot === lastLogged) return;
    lastLogged = snapshot;
    logger.info({ bookingStats }, 'booking outcomes so far');
  }, ms).unref();
}
