import { z } from 'zod';

export const eventIdParamsSchema = z.object({ eventId: z.uuid() });

/** Each tier at most once; a few tickets per tier (the tier's own perUserLimit is checked by the API). */
export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        tierId: z.uuid(),
        qty: z.number({ error: 'Enter a whole number' }).int().min(1).max(10),
      }),
    )
    .min(1, 'Choose at least one ticket')
    .max(10)
    .refine(
      (items) => new Set(items.map((i) => i.tierId)).size === items.length,
      'Each tier may appear only once',
    ),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Booking requests must carry a client-generated UUID, so a retry (double click, flaky network) can be
 * recognised as the same request instead of booking twice. Header names arrive lowercased.
 */
export const idempotencyHeadersSchema = z.object({
  'idempotency-key': z.uuid({ error: 'Send an Idempotency-Key header with a UUID' }),
});

export interface OrderItemView {
  tierId: string;
  tierName: string;
  qty: number;
  unitPricePaise: number;
}

/** A hold: the tickets are reserved until expiresAt, then released unless paid. */
export interface OrderView {
  id: string;
  eventId: string;
  status: 'PENDING' | 'PAID' | 'TICKETED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
  amountPaise: number;
  expiresAt: string;
  items: OrderItemView[];
}

/** A booking refusal: the Redis gate and Postgres build it the same way, so clients can't tell them apart. */
export interface BookingRefusal {
  code: 'SOLD_OUT' | 'PER_USER_LIMIT';
  message: string;
  details: Record<string, unknown>;
}

export const soldOut = (tier: { id: string; name: string }): BookingRefusal => ({
  code: 'SOLD_OUT',
  message: `Not enough "${tier.name}" tickets left`,
  details: { tierId: tier.id, tierName: tier.name },
});

export const perUserLimit = (
  tier: { id: string; name: string; perUserLimit: number },
  held: number,
): BookingRefusal => ({
  code: 'PER_USER_LIMIT',
  message: `You can hold at most ${tier.perUserLimit} "${tier.name}" ticket(s) and already have ${held}`,
  details: { tierId: tier.id, limit: tier.perUserLimit, held },
});
