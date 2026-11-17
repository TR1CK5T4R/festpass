import Razorpay from 'razorpay';
import { env } from '../../config/env.js';

// The only file that talks to Razorpay. Tests replace `paymentGateway.createOrder` with a fake, so no
// test ever calls Razorpay, and no code outside this module knows which provider is used.

const client =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
    : null;

export interface ProviderOrder {
  id: string;
  amount: number;
  currency: string;
}

export const paymentGateway = {
  /** The public key the browser's Checkout needs; null when payments aren't configured. */
  keyId: env.RAZORPAY_KEY_ID ?? null,

  /**
   * Creates a Razorpay order for our order: the amount the buyer will be asked to pay, tied to our
   * order ID (receipt and notes) so the webhook (Day 16) can find it again.
   */
  async createOrder(input: {
    orderId: string;
    amountPaise: number;
    notes: Record<string, string>;
  }): Promise<ProviderOrder> {
    if (!client) throw new Error('Razorpay keys are not configured');
    const order = await client.orders.create({
      amount: input.amountPaise, // Razorpay also counts in paise
      currency: 'INR',
      receipt: input.orderId,
      notes: { orderId: input.orderId, ...input.notes },
    });
    return { id: order.id, amount: Number(order.amount), currency: order.currency };
  },
};
