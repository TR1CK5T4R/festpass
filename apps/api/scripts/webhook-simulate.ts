// Sends the local API a payment.captured webhook for one order, signed with RAZORPAY_WEBHOOK_SECRET
// exactly as Razorpay signs it. For trying the webhook path without a Razorpay account or a tunnel.
// Usage: pnpm webhook:simulate <orderId> [paymentId]   (pass a paymentId again to send a duplicate)
import { randomBytes } from 'node:crypto';
import { prisma } from '@festpass/db';
import { sign } from '../src/modules/webhooks/signature.js';

const [orderId, paymentId = `pay_sim${randomBytes(7).toString('hex')}`] = process.argv.slice(2);
if (!orderId) throw new Error('usage: webhook:simulate <orderId> [paymentId]');
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!secret) throw new Error('Set RAZORPAY_WEBHOOK_SECRET in .env (any long random string)');
const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const order = await prisma.order.findUniqueOrThrow({
  where: { id: orderId },
  select: { amountPaise: true, razorpayOrderId: true, status: true },
});
await prisma.$disconnect();

// The shape Razorpay sends (trimmed to what matters); notes.orderId is copied from the Razorpay order.
const now = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  entity: 'event',
  account_id: 'acc_simulated',
  event: 'payment.captured',
  contains: ['payment'],
  payload: {
    payment: {
      entity: {
        id: paymentId,
        entity: 'payment',
        amount: order.amountPaise,
        currency: 'INR',
        status: 'captured',
        order_id: order.razorpayOrderId,
        method: 'upi',
        captured: true,
        notes: { orderId },
        created_at: now,
      },
    },
  },
  created_at: now,
});

const res = await fetch(`${api}/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(body, secret) },
  body,
});
console.log(`order ${orderId} was ${order.status}; sent payment ${paymentId}`);
console.log(`API answered ${res.status}: ${await res.text()}`);
