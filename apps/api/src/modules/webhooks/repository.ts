import { prisma } from '@festpass/db';

/**
 * The order a payment belongs to: by the Razorpay order ID we stored on /pay, or by our order ID in the
 * payment's notes (set on the Razorpay order, so it is copied onto every payment of it).
 */
export function findOrderForPayment(
  razorpayOrderId: string | null,
  notesOrderId: string | undefined,
) {
  const or = [
    ...(razorpayOrderId ? [{ razorpayOrderId }] : []),
    ...(notesOrderId ? [{ id: notesOrderId }] : []),
  ];
  if (or.length === 0) return null;
  return prisma.order.findFirst({
    where: { OR: or },
    select: { id: true, amountPaise: true, status: true },
  });
}
