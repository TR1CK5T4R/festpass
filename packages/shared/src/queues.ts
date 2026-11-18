import { z } from 'zod';

// Queue and job names and job payloads, shared by the API (which adds jobs) and the worker (which runs
// them). Payloads are validated with Zod in the worker, because a job can outlive the code that queued it.

export const QUEUES = {
  inventory: 'inventory',
  orders: 'orders',
  payments: 'payments',
  tickets: 'tickets',
} as const;

export const JOBS = {
  reconcileInventory: 'reconcile-inventory',
  expireOrder: 'expire-order',
  sweepExpiredOrders: 'sweep-expired-orders',
  refundPayment: 'refund-payment',
  issueTickets: 'issue-tickets',
} as const;

export const expireOrderJobSchema = z.object({
  orderId: z.uuid(),
  /** The request that created the order, so the worker's log lines can be traced back to it. */
  requestId: z.string().optional(),
});
export type ExpireOrderJob = z.infer<typeof expireOrderJobSchema>;

export const refundPaymentJobSchema = z.object({
  /** Our payments row (status refund_pending), not Razorpay's payment ID. */
  paymentId: z.uuid(),
  requestId: z.string().optional(),
});
export type RefundPaymentJob = z.infer<typeof refundPaymentJobSchema>;

export const issueTicketsJobSchema = z.object({
  orderId: z.uuid(),
  requestId: z.string().optional(),
});
export type IssueTicketsJob = z.infer<typeof issueTicketsJobSchema>;
