import type { Prisma } from './index.js';

// The order state machine. Every order status change goes through transition(), never through a plain
// UPDATE elsewhere, so the allowed moves live in one table and every move is guarded the same way.
// Day 16 extends it with payments.

export type OrderStatus = 'PENDING' | 'PAID' | 'TICKETED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PAID', 'EXPIRED', 'CANCELLED'],
  PAID: ['TICKETED', 'REFUNDED'],
  TICKETED: ['REFUNDED'],
  EXPIRED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) =>
  ORDER_TRANSITIONS[from].includes(to);

/**
 * Moves an order from `from` to `to` only if it is still in `from`. Returns false when another
 * process got there first (the row is no longer in `from`), which callers treat as "nothing to do":
 * this guard is what makes jobs that run twice harmless. Throws for a move the table doesn't allow,
 * which is a bug in the caller, not a race.
 */
export async function transition(
  tx: Prisma.TransactionClient,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<boolean> {
  if (!canTransition(from, to)) throw new Error(`order transition ${from} -> ${to} is not allowed`);
  const changed = await tx.$executeRaw`
    UPDATE orders SET status = ${to}::order_status, updated_at = now()
    WHERE id = ${orderId}::uuid AND status = ${from}::order_status`;
  return changed === 1;
}
