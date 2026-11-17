import type { PaymentView } from '@festpass/shared';
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { withTimeout } from '../orders/gate.js';
import { paymentGateway } from './gateway.js';
import * as repo from './repository.js';

const RAZORPAY_TIMEOUT_MS = 10_000;

/**
 * Starts (or resumes) payment for a hold: returns what the browser needs to open Razorpay Checkout.
 *
 * This does NOT mark anything paid. The browser's success callback can be faked or lost, so only
 * Razorpay's signed webhook (Day 16) moves the order to PAID.
 */
export async function startPayment(userId: string, orderId: string): Promise<PaymentView> {
  if (!paymentGateway.keyId) {
    throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not set up on this server');
  }
  const order = await repo.findPayableOrder(orderId);
  // Someone else's order looks exactly like a missing one, so order IDs can't be probed.
  if (!order || order.userId !== userId) throw new NotFoundError('Order not found');
  if (order.status !== 'PENDING') {
    throw new ConflictError(
      'ORDER_NOT_PENDING',
      `This order is ${order.status}, not awaiting payment`,
      {
        status: order.status,
      },
    );
  }
  // The sweeper may not have expired it yet, but a hold past its time must not be paid for.
  if (order.expiresAt <= new Date()) {
    throw new ConflictError('HOLD_EXPIRED', 'Your hold on these tickets has expired; book again');
  }
  // shortcut: free orders can't go through Razorpay (minimum ₹1); they get confirmed with tickets on Day 17.
  if (order.amountPaise === 0) {
    throw new ConflictError('NOTHING_TO_PAY', 'This order is free and needs no payment');
  }

  let razorpayOrderId = order.razorpayOrderId;
  if (!razorpayOrderId) {
    // Outside any transaction: a network call can take seconds, and a transaction waiting on it would
    // hold locks and a pool connection the whole time. Nothing is written until Razorpay has answered.
    let created;
    try {
      created = await withTimeout(
        paymentGateway.createOrder({
          orderId: order.id,
          amountPaise: order.amountPaise,
          notes: { userId },
        }),
        RAZORPAY_TIMEOUT_MS,
      );
    } catch (err) {
      logger.error({ err: (err as Error).message, orderId }, 'razorpay order creation failed');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not start the payment; try again');
    }
    // Pay was clicked twice at once: keep whichever Razorpay order was stored first.
    razorpayOrderId = (await repo.attachProviderOrder(order.id, created.id))
      ? created.id
      : ((await repo.findPayableOrder(orderId))?.razorpayOrderId ?? null);
    if (!razorpayOrderId) {
      throw new ConflictError('ORDER_NOT_PENDING', 'This order stopped awaiting payment');
    }
  }

  return {
    orderId: order.id,
    keyId: paymentGateway.keyId,
    razorpayOrderId,
    amountPaise: order.amountPaise,
    currency: 'INR',
    expiresAt: order.expiresAt.toISOString(),
    description: order.event.title,
    prefill: { name: order.user.name, email: order.user.email },
  };
}
