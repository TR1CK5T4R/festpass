// Redis key names, shared by the API (booking gate) and the worker (reconciliation, hold expiry) so the
// two can never disagree on a name.

export const redisKeys = {
  /** Tickets left in a tier as Redis believes it: capacity - sold_count, kept in step with Postgres. */
  inventory: (tierId: string) => `inv:${tierId}`,
  /** Tickets a user holds in a tier, for the per-user limit. */
  userHeld: (eventId: string, userId: string, tierId: string) =>
    `usr:${eventId}:${userId}:${tierId}`,
  /** Held for one throttle window by whichever API instance will send the event's next update. */
  availabilityThrottle: (eventId: string) => `avail:throttle:${eventId}`,
};

/** Pub/sub channel: "this event's availability changed". The message is just the event ID. */
export const AVAILABILITY_CHANNEL = 'availability-changed';

/**
 * Object keys in the storage bucket. Only orgs/{org}/events/{event}/banner/... is publicly readable (the bucket
 * policy from `pnpm storage:init`); ticket PDFs sit outside that prefix, so every download needs a
 * short-lived pre-signed URL. A banner is meant to be seen by anyone; a ticket PDF carries a name and
 * QR codes that get someone through the gate, so a guessable, permanent public URL would leak both.
 */
export const storageKeys = {
  ticketPdf: (orgId: string, eventId: string, orderId: string) =>
    `orgs/${orgId}/events/${eventId}/tickets/${orderId}.pdf`,
};
