import Razorpay from 'razorpay';

// The only worker code that talks to Razorpay. Tests pass a fake RefundGateway instead.

export interface RefundGateway {
  /** Refunds a captured payment in full. Resolves if it is refunded now or was refunded before. */
  refund(razorpayPaymentId: string): Promise<void>;
}

export function razorpayRefunds(
  keyId: string | undefined,
  keySecret: string | undefined,
): RefundGateway {
  const client = keyId && keySecret ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;
  return {
    async refund(razorpayPaymentId) {
      // Throwing fails the job; BullMQ retries it with backoff and keeps it in Bull Board if it gives up.
      if (!client) throw new Error('Razorpay keys are not configured in the worker');
      try {
        await client.payments.refund(razorpayPaymentId, { speed: 'normal' });
      } catch (err) {
        // If the job crashed after Razorpay refunded but before we recorded it, the retry gets this
        // answer: the money is already back, which is all this call has to make true.
        const description = (err as { error?: { description?: string } }).error?.description ?? '';
        if (/fully refunded/i.test(description)) return;
        throw err;
      }
    },
  };
}
