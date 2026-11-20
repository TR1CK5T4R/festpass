import { prisma } from './index.js';

// Exactly-once email is impossible: the send is a network call to SendGrid, and a crash after SendGrid
// accepted the message but before we recorded it can't be told apart from a send that never happened.
// email_log gets as close as it can: one row per (order, template); sent_at records success; claimed_at
// is a short lease so two concurrent runs (a retry racing a slow first attempt) don't both send.

const LEASE = '5 minutes';

/**
 * Takes the right to send this order's email. False if it was already sent, or another run is sending
 * it right now (its lease hasn't run out). An expired lease means that run died, so the email is retried.
 */
export async function claimEmail(orderId: string, template: string): Promise<boolean> {
  await prisma.$executeRaw`
    INSERT INTO email_log (order_id, template) VALUES (${orderId}::uuid, ${template})
    ON CONFLICT (order_id, template) DO NOTHING`;
  const claimed = await prisma.$executeRaw`
    UPDATE email_log SET claimed_at = now()
    WHERE order_id = ${orderId}::uuid AND template = ${template} AND sent_at IS NULL
      AND (claimed_at IS NULL OR claimed_at < now() - ${LEASE}::interval)`;
  return claimed === 1;
}

export async function markEmailSent(orderId: string, template: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_log SET sent_at = now() WHERE order_id = ${orderId}::uuid AND template = ${template}`;
}

/** After a failed send: drop the lease, so the job's retry can claim it again at once. */
export async function releaseEmailClaim(orderId: string, template: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_log SET claimed_at = NULL
    WHERE order_id = ${orderId}::uuid AND template = ${template} AND sent_at IS NULL`;
}

/** Who to write to and what about: the buyer, the event and the order. */
export function findOrderForEmail(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      amountPaise: true,
      user: { select: { name: true, email: true } },
      event: {
        select: { id: true, orgId: true, title: true, slug: true, venue: true, startsAt: true },
      },
      tickets: {
        select: {
          id: true,
          seq: true,
          code: true,
          qrVersion: true,
          createdAt: true,
          tier: { select: { name: true } },
        },
        orderBy: { seq: 'asc' },
      },
    },
  });
}
export type OrderForEmail = NonNullable<Awaited<ReturnType<typeof findOrderForEmail>>>;
