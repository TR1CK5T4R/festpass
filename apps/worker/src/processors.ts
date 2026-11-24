import {
  findOverdueHolds,
  findWaitingRoomEvent,
  releaseHold,
  type ReleasedHold,
} from '@festpass/db/booking';
import {
  claimEmail,
  findOrderForEmail,
  markEmailSent,
  releaseEmailClaim,
  type OrderForEmail,
} from '@festpass/db/emails';
import { reconcileInventory } from '@festpass/db/inventory';
import { orderStatus } from '@festpass/db/order-state';
import { findPayment, markPaymentRefunded } from '@festpass/db/payments';
import { issueTickets } from '@festpass/db/tickets';
import { recordScanEvent } from '@festpass/mongo';
import {
  expireOrderJobSchema,
  formatPaise,
  issueTicketsJobSchema,
  JOBS,
  orderEmailJobSchema,
  refundPaymentJobSchema,
  scanEventJobSchema,
  storageKeys,
  ticketQrPayload,
  type EmailTemplate,
  type TicketQrPayload,
} from '@festpass/shared';
import {
  activeWaitingRooms,
  admitNext,
  announceAvailabilityChange,
  closeWaitingRoom,
  releaseRedisStock,
} from '@festpass/shared/server';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { EmailMessage, EmailProvider } from './email/provider.js';
import { buildTicketsPdf, qrPng } from './pdf.js';
import type { RefundGateway } from './refunds.js';
import type { TicketStorage } from './storage.js';

// What each job does, kept apart from the BullMQ wiring in index.ts so tests can call it directly
// with fakes for whatever a job talks to.

export interface WorkerDeps {
  redis?: Redis;
  log: Logger;
  refunds?: RefundGateway;
  email?: EmailProvider;
  storage?: TicketStorage;
  signTicket?: (payload: TicketQrPayload) => string;
  /** Where follow-up emails are queued; left out in tests that don't care about them. */
  emailsQueue?: Queue;
  webUrl?: string;
  admissionSecret?: string;
}

function need<K extends keyof WorkerDeps>(deps: WorkerDeps, key: K): NonNullable<WorkerDeps[K]> {
  const value = deps[key];
  if (value === undefined) throw new Error(`this job needs ${key}`);
  return value as NonNullable<WorkerDeps[K]>;
}

/** The most overdue holds the sweeper expires per run; anything left waits for the next minute. */
const SWEEP_BATCH = 500;
/** How long the download link in the ticket email works. */
const EMAIL_LINK_SECONDS = 24 * 60 * 60;

/**
 * Queues an email about an order. The job ID makes queuing it twice a no-op, and email_log stops a
 * second send even if it were queued again later, so callers queue whenever the order is in the right
 * state, not only the first time they change it (a lost follow-up gets queued on the next run).
 */
async function queueEmail(deps: WorkerDeps, job: string, orderId: string, requestId?: string) {
  await deps.emailsQueue?.add(job, { orderId, requestId }, { jobId: `${job}-${orderId}` });
}

/**
 * After the Postgres release has committed, gives the gate its stock back. A failure here only logs:
 * failing the job would retry it, but the retry would find the order already EXPIRED and do nothing,
 * so Redis would stay low anyway. Reconciliation (every minute) fixes inv:*, and usr:* keys expire.
 */
async function releaseInRedis(deps: WorkerDeps, hold: ReleasedHold) {
  try {
    const redis = need(deps, 'redis');
    await releaseRedisStock(redis, hold.eventId, hold.userId, hold.items);
    await announceAvailabilityChange(redis, hold.eventId);
  } catch (err) {
    deps.log.warn(
      { err: (err as Error).message, orderId: hold.orderId },
      'redis release failed; reconciliation will fix it',
    );
  }
}

/** expire-order: ends one hold whose time is up. Running it twice, or after a cancel, does nothing. */
export async function expireOrder(data: unknown, deps: WorkerDeps) {
  const { orderId, requestId } = expireOrderJobSchema.parse(data);
  const hold = await releaseHold(orderId, 'EXPIRED');
  if (hold) {
    await releaseInRedis(deps, hold);
    deps.log.info({ orderId, requestId, items: hold.items }, 'hold expired, tickets back on sale');
  } else {
    deps.log.debug(
      { orderId, requestId },
      'hold already ended (paid, cancelled or expired), nothing to do',
    );
  }
  if ((await orderStatus(orderId)) === 'EXPIRED')
    await queueEmail(deps, JOBS.sendOrderExpired, orderId, requestId);
  return { released: hold !== null };
}

/**
 * sweep-expired-orders: the safety net for expiry jobs that never ran (Redis lost them, the API
 * couldn't queue one, the worker was down past the deadline). Uses the same guarded release, so an
 * order its own job expires at the same moment is still released once.
 */
export async function sweepExpiredOrders(deps: WorkerDeps) {
  let expired = 0;
  for (const orderId of await findOverdueHolds(SWEEP_BATCH)) {
    const hold = await releaseHold(orderId, 'EXPIRED');
    if (!hold) continue;
    await releaseInRedis(deps, hold);
    await queueEmail(deps, JOBS.sendOrderExpired, orderId);
    expired++;
  }
  if (expired > 0) deps.log.warn({ expired }, 'sweeper expired holds whose job never ran');
  return { expired };
}

/**
 * refund-payment: returns a payment that can't be kept (paid after the hold ran out and the tickets
 * were gone, paid for a cancelled order, or a second payment for an order already paid). Safe to run
 * twice: it only acts on a payment still marked refund_pending, Razorpay's "already refunded" counts as
 * done, and markPaymentRefunded() is a guarded update.
 */
export async function refundPayment(data: unknown, deps: WorkerDeps) {
  const { paymentId, requestId } = refundPaymentJobSchema.parse(data);
  const payment = await findPayment(paymentId);
  let refunded = false;
  if (payment?.status === 'refund_pending') {
    await need(deps, 'refunds').refund(payment.razorpayPaymentId); // network call, outside any transaction
    await markPaymentRefunded(paymentId);
    deps.log.info({ paymentId, orderId: payment.orderId, requestId }, 'payment refunded');
    refunded = true;
  } else {
    deps.log.debug({ paymentId, requestId }, 'payment is not waiting for a refund, nothing to do');
  }
  if (payment && (refunded || payment.status === 'refunded')) {
    await queueEmail(deps, JOBS.sendRefundIssued, payment.orderId, requestId);
  }
  return { refunded };
}

/** issue-tickets: one ticket per unit of a paid order, then TICKETED. Running it again does nothing. */
export async function issueOrderTickets(data: unknown, deps: WorkerDeps) {
  const { orderId, requestId } = issueTicketsJobSchema.parse(data);
  const result = await issueTickets(orderId);
  if (!result) throw new Error(`order ${orderId} not found`);
  if (result.issued > 0)
    deps.log.info({ orderId, requestId, issued: result.issued }, 'tickets issued');
  else deps.log.debug({ orderId, status: result.status }, 'no tickets to issue');
  if (result.status === 'TICKETED') await queueEmail(deps, JOBS.sendTickets, orderId, requestId);
  return result;
}

/**
 * write-scan-event: a scan the API couldn't write to MongoDB. The check-in itself already stands in
 * Postgres; this only catches up the history. Throwing retries it with the job's long backoff.
 */
export async function writeScanEvent(data: unknown, deps: WorkerDeps) {
  const event = scanEventJobSchema.parse(data);
  await recordScanEvent(event);
  deps.log.info(
    { ticketId: event.ticketId, result: event.result },
    'scan event written after a retry',
  );
  return { written: true };
}

export async function reconcile(deps: WorkerDeps) {
  const drift = await reconcileInventory(need(deps, 'redis'));
  // Drift means the gate and Postgres disagreed: a failed release, a timed-out script, a restart.
  if (drift.length > 0) deps.log.warn({ drift }, 'fixed inventory drift in redis');
  return { fixed: drift.length };
}

/**
 * One second's admissions for one event. The rate is read here on every tick, so a change from the
 * organizer applies within a second. A line whose sale is over, or whose queue mode was turned off, is
 * deleted: the people in it find out on their next status check (sale over, or go straight to booking).
 */
async function admitOneRoom(eventId: string, redis: Redis, secret: string) {
  const event = await findWaitingRoomEvent(eventId);
  const now = new Date();
  if (!event || !event.queueMode || event.status !== 'PUBLISHED' || now >= event.saleEndsAt) {
    await closeWaitingRoom(redis, eventId);
    return 0;
  }
  // The organizer moved the sale later: keep everyone's place, because a token now would expire unused.
  if (now < event.saleStartsAt) return 0;
  return (await admitNext(redis, eventId, event.admitRatePerSec, secret)).length;
}

/** admit-waiting-rooms: each second, serves every event with people in line. One failure can't stop the rest. */
export async function admitWaitingRooms(deps: WorkerDeps) {
  const redis = need(deps, 'redis');
  const secret = need(deps, 'admissionSecret');
  const eventIds = await activeWaitingRooms(redis);
  const results = await Promise.allSettled(eventIds.map((id) => admitOneRoom(id, redis, secret)));
  let admitted = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') admitted += result.value;
    else
      deps.log.error({ err: String(result.reason), eventId: eventIds[i] }, 'could not admit a room');
  });
  return { admitted };
}

// ---- Emails ----

const formatEventDate = (date: Date) =>
  date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/**
 * Sends one email about an order at most once: claim it in email_log, compose it, send it, record it.
 * A failed send releases the claim and throws, so BullMQ retries; a retry after a successful send finds
 * sent_at set and stops. `compose` returns null when the email no longer applies.
 */
async function sendOnce(
  template: EmailTemplate,
  data: unknown,
  deps: WorkerDeps,
  compose: (order: OrderForEmail) => Promise<EmailMessage | null>,
) {
  const { orderId, requestId } = orderEmailJobSchema.parse(data);
  if (!(await claimEmail(orderId, template))) {
    deps.log.debug({ orderId, template }, 'email already sent (or being sent), skipping');
    return { sent: false };
  }
  try {
    const order = await findOrderForEmail(orderId);
    const message = order && (await compose(order));
    if (!message) {
      await releaseEmailClaim(orderId, template);
      return { sent: false };
    }
    await need(deps, 'email').send(message);
    await markEmailSent(orderId, template);
    deps.log.info({ orderId, template, requestId }, 'email sent');
    return { sent: true };
  } catch (err) {
    await releaseEmailClaim(orderId, template);
    throw err;
  }
}

/**
 * send-tickets: builds the PDF (one page per ticket), stores it under the bucket's private tickets
 * prefix, and emails a 24-hour download link plus each QR inline. The PDF is uploaded before the email
 * goes out, so "Download PDF" on the site works even if the email provider is down.
 */
export function sendTickets(data: unknown, deps: WorkerDeps) {
  return sendOnce('ticket-confirmation', data, deps, async (order) => {
    if (order.tickets.length === 0) return null;
    const sign = need(deps, 'signTicket');
    const tickets = order.tickets.map((t) => ({
      ...t,
      qr: sign(ticketQrPayload({ ...t, eventId: order.event.id })),
    }));
    const eventDate = formatEventDate(order.event.startsAt);
    const pdf = await buildTicketsPdf({
      eventTitle: order.event.title,
      eventDate,
      venue: order.event.venue,
      attendeeName: order.user.name,
      tickets: tickets.map((t) => ({ code: t.code, tierName: t.tier.name, qr: t.qr })),
    });
    const storage = need(deps, 'storage');
    const key = storageKeys.ticketPdf(order.event.orgId, order.event.id, order.id);
    await storage.put(key, pdf, 'application/pdf');
    const downloadUrl = await storage.signedDownloadUrl(
      key,
      EMAIL_LINK_SECONDS,
      `festpass-${order.event.slug}.pdf`,
    );

    return {
      to: order.user,
      template: 'ticket-confirmation',
      data: {
        name: order.user.name,
        eventTitle: order.event.title,
        eventDate,
        venue: order.event.venue,
        tickets: tickets.map((t) => ({ code: t.code, tier: t.tier.name, qrCid: `qr-${t.seq}` })),
        downloadUrl,
        downloadExpiresAt: formatEventDate(new Date(Date.now() + EMAIL_LINK_SECONDS * 1000)),
        ticketsUrl: `${deps.webUrl ?? ''}/tickets`,
      },
      inlineImages: await Promise.all(
        tickets.map(async (t) => ({
          contentId: `qr-${t.seq}`,
          filename: `ticket-${t.seq}.png`,
          content: await qrPng(t.qr),
          type: 'image/png' as const,
        })),
      ),
    };
  });
}

/** send-order-expired: the hold ran out; not sent if a late payment has since re-reserved it. */
export function sendOrderExpired(data: unknown, deps: WorkerDeps) {
  return sendOnce('order-expired', data, deps, async (order) => {
    if (order.status !== 'EXPIRED') return null;
    return {
      to: order.user,
      template: 'order-expired',
      data: {
        name: order.user.name,
        eventTitle: order.event.title,
        bookAgainUrl: `${deps.webUrl ?? ''}/e/${order.event.slug}`,
      },
    };
  });
}

const REFUND_REASONS: Partial<Record<OrderForEmail['status'], string>> = {
  REFUNDED: 'your payment arrived after your hold ended and the tickets had sold out',
  CANCELLED: 'you cancelled the order before the payment came through',
  PAID: 'it was a second payment for an order that was already paid',
  TICKETED: 'it was a second payment for an order that was already paid',
};

/** send-refund-issued: after the refund job has given the money back. */
export function sendRefundIssued(data: unknown, deps: WorkerDeps) {
  return sendOnce('refund-issued', data, deps, async (order) => ({
    to: order.user,
    template: 'refund-issued',
    data: {
      name: order.user.name,
      eventTitle: order.event.title,
      amount: formatPaise(order.amountPaise),
      reason: REFUND_REASONS[order.status] ?? 'the payment could not be used',
    },
  }));
}

/** Routes a job to its processor by name. */
export function processJob(job: Job, deps: WorkerDeps) {
  const jobDeps = {
    ...deps,
    log: deps.log.child({ job: job.id, name: job.name, attempt: job.attemptsMade + 1 }),
  };
  switch (job.name) {
    case JOBS.expireOrder:
      return expireOrder(job.data, jobDeps);
    case JOBS.sweepExpiredOrders:
      return sweepExpiredOrders(jobDeps);
    case JOBS.reconcileInventory:
      return reconcile(jobDeps);
    case JOBS.issueTickets:
      return issueOrderTickets(job.data, jobDeps);
    case JOBS.refundPayment:
      return refundPayment(job.data, jobDeps);
    case JOBS.writeScanEvent:
      return writeScanEvent(job.data, jobDeps);
    case JOBS.sendTickets:
      return sendTickets(job.data, jobDeps);
    case JOBS.sendOrderExpired:
      return sendOrderExpired(job.data, jobDeps);
    case JOBS.sendRefundIssued:
      return sendRefundIssued(job.data, jobDeps);
    case JOBS.admitWaitingRooms:
      return admitWaitingRooms(jobDeps);
    default:
      throw new Error(`unknown job ${job.name}`);
  }
}
