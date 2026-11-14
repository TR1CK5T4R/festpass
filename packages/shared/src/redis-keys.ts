// Redis key and queue names, shared by the API (booking gate) and the worker (reconciliation) so the two
// can never disagree on a name.

export const redisKeys = {
  /** Tickets left in a tier as Redis believes it: capacity - sold_count, kept in step with Postgres. */
  inventory: (tierId: string) => `inv:${tierId}`,
  /** Tickets a user holds in a tier, for the per-user limit. */
  userHeld: (eventId: string, userId: string, tierId: string) =>
    `usr:${eventId}:${userId}:${tierId}`,
};

export const QUEUES = { inventory: 'inventory' } as const;
export const JOBS = { reconcileInventory: 'reconcile-inventory' } as const;
