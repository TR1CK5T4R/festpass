import { Prisma, prisma } from './index.js';
import { transition, type OrderStatus } from './order-state.js';

// What a captured payment does to its order, in one transaction. Webhooks are delivered at least
// once, possibly many times and in any order, so everything here is keyed on the payment ID and every
// status change is a guarded transition: running it again for the same payment changes nothing.

export type RefundReason = 'NO_STOCK' | 'ORDER_CANCELLED' | 'ALREADY_PAID';

export type PaymentOutcome =
  /** This payment ID was recorded before: a redelivered webhook. */
  | { kind: 'duplicate' }
  /** The order is now PAID (late: it had expired and its tickets were reserved again). */
  | { kind: 'paid'; late: boolean }
  /** The money must go back; the payment is marked refund_pending for the refund job. */
  | { kind: 'refund'; paymentId: string; reason: RefundReason };

export interface CapturedPayment {
  orderId: string;
  razorpayPaymentId: string;
  /** The verified webhook body, kept for audits and disputes. Never logged. */
  rawPayload: unknown;
}

export async function recordCapturedPayment(payment: CapturedPayment): Promise<PaymentOutcome> {
  return prisma.$transaction(async (tx) => {
    // 1. The unique payment ID is the idempotency key Razorpay gives us. A redelivery inserts nothing,
    //    and nothing below runs a second time.
    const [inserted] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payments (order_id, razorpay_payment_id, status, raw_payload)
      VALUES (${payment.orderId}::uuid, ${payment.razorpayPaymentId}, 'captured',
              ${JSON.stringify(payment.rawPayload)}::jsonb)
      ON CONFLICT (razorpay_payment_id) DO NOTHING
      RETURNING id`;
    if (!inserted) return { kind: 'duplicate' };

    // 2. Lock the order, so the expiry job, a cancel or another payment for it wait their turn.
    const [order] = await tx.$queryRaw<{ status: OrderStatus }[]>`
      SELECT status FROM orders WHERE id = ${payment.orderId}::uuid FOR UPDATE`;
    const refund = async (reason: RefundReason) => {
      await tx.$executeRaw`UPDATE payments SET status = 'refund_pending' WHERE id = ${inserted.id}::uuid`;
      return { kind: 'refund', paymentId: inserted.id, reason } as const;
    };

    switch (order!.status) {
      case 'PENDING':
        // Still held (even if past expires_at, the tickets are still ours until the expiry job runs).
        await transition(tx, payment.orderId, 'PENDING', 'PAID');
        return { kind: 'paid', late: false };
      case 'EXPIRED':
        // Paid after the hold ran out and its tickets went back on sale: take them again if they are
        // still there, with the same conditional UPDATE booking uses; otherwise refund.
        if (await reserveAgain(tx, payment.orderId)) {
          await transition(tx, payment.orderId, 'EXPIRED', 'PAID');
          return { kind: 'paid', late: true };
        }
        return refund('NO_STOCK');
      case 'CANCELLED':
        return refund('ORDER_CANCELLED');
      default:
        // PAID, TICKETED or REFUNDED: a second, different payment for an order already settled.
        return refund('ALREADY_PAID');
    }
  });
}

/** Takes the order's tickets again, all or none (tier-ID order, like booking, so no deadlocks). */
async function reserveAgain(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const items = await tx.$queryRaw<{ tier_id: string; qty: number }[]>`
    SELECT tier_id, qty FROM order_items WHERE order_id = ${orderId}::uuid ORDER BY tier_id`;
  await tx.$executeRaw`SAVEPOINT reserve_again`;
  for (const item of items) {
    const updated = await tx.$executeRaw`
      UPDATE ticket_tiers SET sold_count = sold_count + ${item.qty}, updated_at = now()
      WHERE id = ${item.tier_id}::uuid AND sold_count + ${item.qty} <= capacity`;
    if (updated === 0) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT reserve_again`; // give back tiers already taken
      return false;
    }
  }
  return true;
}

export interface RefundablePayment {
  id: string;
  orderId: string;
  razorpayPaymentId: string;
  status: string;
}

export function findPayment(paymentId: string): Promise<RefundablePayment | null> {
  return prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, orderId: true, razorpayPaymentId: true, status: true },
  });
}

/** Payments that still need a refund (state, not events: a lost job is found again here). */
export async function findPendingRefunds(orderId: string): Promise<string[]> {
  const rows = await prisma.payment.findMany({
    where: { orderId, status: 'refund_pending' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * After Razorpay has refunded the money: marks the payment refunded and, if the order had expired,
 * moves it to REFUNDED. A refund of a second payment on a paid order, or of a cancelled order, leaves
 * the order as it is. Guarded, so a job that runs twice does this once.
 */
export async function markPaymentRefunded(paymentId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [payment] = await tx.$queryRaw<{ order_id: string }[]>`
      UPDATE payments SET status = 'refunded'
      WHERE id = ${paymentId}::uuid AND status = 'refund_pending'
      RETURNING order_id`;
    if (!payment) return false;
    await transition(tx, payment.order_id, 'EXPIRED', 'REFUNDED'); // no-op unless the order is EXPIRED
    return true;
  });
}
