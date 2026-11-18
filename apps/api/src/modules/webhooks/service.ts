import { findPendingRefunds, recordCapturedPayment } from '@festpass/db/payments';
import { JOBS } from '@festpass/shared';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { paymentsQueue, ticketsQueue } from '../../lib/queues.js';
import * as repo from './repository.js';
import { isValidSignature } from './signature.js';

// The events that mean "money was taken". order.paid and payment.captured usually both arrive for one
// payment, in either order; the payment ID makes the second one a no-op.
const PAYMENT_EVENTS = new Set(['payment.captured', 'order.paid']);

const webhookSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            amount: z.number().int(),
            order_id: z.string().nullable().optional(),
            notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
          }),
        })
        .optional(),
    })
    .optional(),
});

export type WebhookResult = { handled: false; reason: string } | { handled: true; outcome: string };

/**
 * Verify, record, enqueue, respond: everything slow (refunds, tickets) runs in the worker, so Razorpay
 * gets its 200 in milliseconds and doesn't time out and resend.
 */
export async function handleRazorpayWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  requestId: string,
): Promise<WebhookResult> {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError(503, 'WEBHOOKS_NOT_CONFIGURED', 'Webhook secret is not set on this server');
  }
  // Nothing is parsed, looked up or logged from an unverified body.
  if (!isValidSignature(rawBody, signature, secret)) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Webhook signature does not match');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    body = undefined;
  }
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'INVALID_PAYLOAD', 'Unexpected webhook payload');
  const { event, payload } = parsed.data;
  const payment = payload?.payment?.entity;
  if (!PAYMENT_EVENTS.has(event) || !payment) return { handled: false, reason: `ignored ${event}` };

  const notes = payment.notes && !Array.isArray(payment.notes) ? payment.notes : {};
  const order = await repo.findOrderForPayment(
    payment.order_id ?? null,
    typeof notes.orderId === 'string' ? notes.orderId : undefined,
  );
  if (!order) {
    // A payment we can't match (another app on the same Razorpay account?): acknowledge, or Razorpay
    // retries it for days. Logged with IDs only, never the payload.
    logger.warn(
      { paymentId: payment.id, razorpayOrderId: payment.order_id },
      'webhook for an unknown order',
    );
    return { handled: false, reason: 'unknown order' };
  }
  if (payment.amount !== order.amountPaise) {
    // Razorpay charges the amount of the Razorpay order we created, so this should never happen.
    logger.error(
      { paymentId: payment.id, orderId: order.id },
      'webhook amount differs from the order amount',
    );
  }

  const outcome = await recordCapturedPayment({
    orderId: order.id,
    razorpayPaymentId: payment.id,
    rawPayload: parsed.data,
  });
  logger.info(
    { paymentId: payment.id, orderId: order.id, event, outcome },
    'razorpay webhook processed',
  );

  // Follow-up jobs come from what is stored now, not from what this delivery did. If queuing failed
  // last time (Redis down), the answer was a 500, Razorpay delivers again, the payment is a
  // "duplicate", and the job is queued now. Job IDs make queuing twice harmless.
  await queueFollowUps(order.id, requestId);
  return { handled: true, outcome: outcome.kind };
}

async function queueFollowUps(orderId: string, requestId: string) {
  const current = await repo.findOrderForPayment(null, orderId);
  if (current?.status === 'PAID') {
    await ticketsQueue.add(JOBS.issueTickets, { orderId, requestId }, { jobId: orderId });
  }
  for (const paymentId of await findPendingRefunds(orderId)) {
    await paymentsQueue.add(JOBS.refundPayment, { paymentId, requestId }, { jobId: paymentId });
  }
}
