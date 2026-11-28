import { z } from 'zod';
import { SCAN_RESULTS } from './checkins.ts';

// Queue and job names and job payloads, shared by the API (which adds jobs) and the worker (which runs
// them). Payloads are validated with Zod in the worker, because a job can outlive the code that queued it.

export const QUEUES = {
  inventory: 'inventory',
  orders: 'orders',
  payments: 'payments',
  tickets: 'tickets',
  emails: 'emails',
  scans: 'scans',
  waitingRoom: 'waiting-room',
  reports: 'reports',
} as const;

export const JOBS = {
  reconcileInventory: 'reconcile-inventory',
  expireOrder: 'expire-order',
  sweepExpiredOrders: 'sweep-expired-orders',
  refundPayment: 'refund-payment',
  issueTickets: 'issue-tickets',
  sendTickets: 'send-tickets',
  sendOrderExpired: 'send-order-expired',
  sendRefundIssued: 'send-refund-issued',
  writeScanEvent: 'write-scan-event',
  admitWaitingRooms: 'admit-waiting-rooms',
  sendSponsorReport: 'send-sponsor-report',
} as const;

/** The emails an order can get; each is sent at most once per order (email_log). */
export const EMAIL_TEMPLATES = [
  'ticket-confirmation',
  'order-expired',
  'refund-issued',
  'sponsor-report',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

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

/** Every email job: the order it is about, and the request that led to it (for tracing in logs). */
export const orderEmailJobSchema = z.object({
  orderId: z.uuid(),
  requestId: z.string().optional(),
});
export type OrderEmailJob = z.infer<typeof orderEmailJobSchema>;

/** A scan whose write to MongoDB failed: everything the ScanEvent needs, to write it again later. */
export const scanEventJobSchema = z.object({
  ts: z.iso.datetime().transform((s) => new Date(s)),
  meta: z.object({
    eventId: z.uuid(),
    type: z.enum(['GATE', 'BOOTH']),
    gateOrBoothId: z.string(),
  }),
  ticketId: z.string().nullable(),
  scannerUserId: z.uuid(),
  deviceId: z.string(),
  result: z.enum(SCAN_RESULTS),
  offline: z.boolean(),
  college: z.string().nullable(),
  branch: z.string().nullable(),
  graduationYear: z.number().int().nullable(),
  tierName: z.string().nullable(),
});

/** A sponsor's post-event report, queued when its event closes (jobId = sponsor-report-{sponsorId}). */
export const sponsorReportJobSchema = z.object({
  sponsorId: z.uuid(),
  requestId: z.string().optional(),
});
export type SponsorReportJob = z.infer<typeof sponsorReportJobSchema>;
