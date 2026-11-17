import { prisma } from '@festpass/db';

/**
 * Stores the Razorpay order ID only if none is stored yet and the order is still pending. Two pay
 * requests racing each other can both create a Razorpay order; this lets exactly one ID win, and the
 * other request returns that one (its own Razorpay order is never shown to anyone, so it is never paid).
 */
export async function attachProviderOrder(orderId: string, razorpayOrderId: string) {
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING', razorpayOrderId: null },
    data: { razorpayOrderId },
  });
  return count === 1;
}

export function findPayableOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      amountPaise: true,
      expiresAt: true,
      razorpayOrderId: true,
      event: { select: { title: true } },
      user: { select: { name: true, email: true } },
    },
  });
}
