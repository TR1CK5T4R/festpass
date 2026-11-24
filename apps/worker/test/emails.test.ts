import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { storageKeys } from '@festpass/shared';
import { createTicketSigner } from '@festpass/shared/server';
import type { Queue } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleProvider } from '../src/email/console.js';
import type { EmailMessage, EmailProvider } from '../src/email/provider.js';
import { buildTicketsPdf } from '../src/pdf.js';
import {
  expireOrder,
  issueOrderTickets,
  sendOrderExpired,
  sendRefundIssued,
  sendTickets,
  type WorkerDeps,
} from '../src/processors.js';
import type { TicketStorage } from '../src/storage.js';

const log = pino({ level: 'silent' });
const keys = generateKeyPairSync('ed25519');

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

/** Fakes for everything the email jobs talk to. */
function fakes() {
  const sent: EmailMessage[] = [];
  const stored = new Map<string, Buffer>();
  const email: EmailProvider = { send: vi.fn(async (m: EmailMessage) => void sent.push(m)) };
  const storage: TicketStorage = {
    put: async (key, body) => void stored.set(key, body),
    signedDownloadUrl: async (key, seconds) => `https://storage.test/${key}?expires=${seconds}`,
  };
  const emailsQueue = { add: vi.fn() } as unknown as Queue & { add: ReturnType<typeof vi.fn> };
  const deps: WorkerDeps = {
    log,
    email,
    storage,
    emailsQueue,
    signTicket: createTicketSigner(keys.privateKey),
    webUrl: 'http://localhost:3000',
  };
  return { deps, sent, stored, email, emailsQueue };
}

/** A paid order for 2 tickets, issued: what the payment webhook and issue-tickets leave behind. */
async function ticketedOrder(status: 'PAID' | 'EXPIRED' = 'PAID') {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@test.dev`, name: 'Asha Verma', passwordHash: 'x' },
  });
  const org = await prisma.organization.create({
    data: { name: 'Club', slug: `club-${randomUUID()}` },
  });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'HackMAIT 2026',
      slug: `hackmait-${randomUUID().slice(0, 8)}`,
      description: '',
      venue: 'MAIT Auditorium',
      startsAt: new Date('2026-12-04T04:30:00Z'),
      endsAt: new Date('2026-12-05T04:30:00Z'),
      saleStartsAt: new Date(Date.now() - 3600_000),
      saleEndsAt: new Date(Date.now() + 24 * 3600_000),
      status: 'PUBLISHED',
      tiers: { create: { name: 'Regular', pricePaise: 29_900, capacity: 10, soldCount: 2 } },
    },
    include: { tiers: true },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      eventId: event.id,
      status,
      amountPaise: 59_800,
      expiresAt: new Date(Date.now() - 1000),
      items: { create: { tierId: event.tiers[0]!.id, qty: 2, unitPricePaise: 29_900 } },
    },
  });
  if (status === 'PAID') await issueOrderTickets({ orderId: order.id }, { log });
  return { orderId: order.id, eventId: event.id, orgId: org.id, user };
}

describe('ticket PDF', () => {
  it('builds a non-empty PDF', async () => {
    const pdf = await buildTicketsPdf({
      eventTitle: 'HackMAIT 2026',
      eventDate: 'Fri, 4 Dec, 2026, 10:00 am IST',
      venue: 'MAIT Auditorium',
      attendeeName: 'Asha Verma',
      tickets: [
        { code: 'K7QM-X9PA', tierName: 'Regular', qr: 'FP1.test.one' },
        { code: 'R2ZB-H8NC', tierName: 'Regular', qr: 'FP1.test.two' },
      ],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });
});

describe('send-tickets', () => {
  it('stores the PDF privately, emails a 24 h link and each QR inline, and records it', async () => {
    const { deps, sent, stored } = fakes();
    const { orderId, eventId, orgId, user } = await ticketedOrder();

    expect(await sendTickets({ orderId }, deps)).toEqual({ sent: true });

    const key = storageKeys.ticketPdf(orgId, eventId, orderId);
    expect(key).not.toContain('/banner/'); // outside the public prefix
    expect(stored.get(key)?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message).toMatchObject({
      to: { email: user.email, name: 'Asha Verma' },
      template: 'ticket-confirmation',
      data: {
        eventTitle: 'HackMAIT 2026',
        downloadUrl: `https://storage.test/${key}?expires=86400`,
        ticketsUrl: 'http://localhost:3000/tickets',
      },
    });
    expect(message!.inlineImages!.map((i) => i.contentId)).toEqual(['qr-1', 'qr-2']);
    const log = await prisma.emailLog.findFirstOrThrow({ where: { orderId } });
    expect(log.sentAt).not.toBeNull();
  });

  it('on retry, and when two runs race, it is sent once', async () => {
    const { deps, email } = fakes();
    const { orderId } = await ticketedOrder();

    await Promise.all([sendTickets({ orderId }, deps), sendTickets({ orderId }, deps)]);
    expect(await sendTickets({ orderId }, deps)).toEqual({ sent: false });

    expect(email.send).toHaveBeenCalledOnce();
  });

  it('a failed send is retried by the next run, and still sent once', async () => {
    const { deps, email } = fakes();
    const { orderId } = await ticketedOrder();
    vi.mocked(email.send).mockRejectedValueOnce(new Error('SendGrid 503'));

    await expect(sendTickets({ orderId }, deps)).rejects.toThrow('SendGrid 503');
    expect(await sendTickets({ orderId }, deps)).toEqual({ sent: true });
    expect(await sendTickets({ orderId }, deps)).toEqual({ sent: false });
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('lists each ticket by its real code and tier, with its QR as an inline PNG', async () => {
    const { deps, sent } = fakes();
    const { orderId } = await ticketedOrder();
    await sendTickets({ orderId }, deps);

    const tickets = await prisma.ticket.findMany({ where: { orderId }, orderBy: { seq: 'asc' } });
    expect(sent[0]!.data.tickets).toEqual([
      { code: tickets[0]!.code, tier: 'Regular', qrCid: 'qr-1' },
      { code: tickets[1]!.code, tier: 'Regular', qrCid: 'qr-2' },
    ]);
    for (const image of sent[0]!.inlineImages!) {
      expect(image.content.subarray(1, 4).toString()).toBe('PNG');
    }
  });
});

describe('follow-up emails', () => {
  it('issuing tickets, an expired hold and a refund each queue their email, keyed by the order', async () => {
    const { deps, emailsQueue } = fakes();
    const paid = await ticketedOrder();
    await issueOrderTickets({ orderId: paid.orderId }, deps); // a re-run queues it again (harmless)
    const expired = await ticketedOrder('EXPIRED');
    await expireOrder({ orderId: expired.orderId }, deps);

    expect(emailsQueue.add.mock.calls.map(([name, , opts]) => [name, opts.jobId])).toEqual([
      ['send-tickets', `send-tickets-${paid.orderId}`],
      ['send-order-expired', `send-order-expired-${expired.orderId}`],
    ]);
  });

  it('order-expired is sent for an expired hold, and refund-issued names the amount', async () => {
    const { deps, sent } = fakes();
    const { orderId } = await ticketedOrder('EXPIRED');

    await sendOrderExpired({ orderId }, deps);
    await sendRefundIssued({ orderId }, deps);

    expect(sent.map((m) => [m.template, m.data])).toEqual([
      [
        'order-expired',
        expect.objectContaining({
          bookAgainUrl: expect.stringMatching(/^http:\/\/localhost:3000\/e\//),
        }),
      ],
      ['refund-issued', expect.objectContaining({ amount: '₹598.00' })],
    ]);
  });

  it('no order-expired email once a late payment has re-reserved the tickets', async () => {
    const { deps, sent } = fakes();
    const { orderId } = await ticketedOrder();
    expect(await sendOrderExpired({ orderId }, deps)).toEqual({ sent: false });
    expect(sent).toEqual([]);
  });
});

describe('console provider', () => {
  it('writes an HTML preview with the QR images next to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'festpass-email-'));
    const { deps } = fakes();
    const { orderId } = await ticketedOrder();
    await sendTickets({ orderId }, { ...deps, email: consoleProvider(dir, log) });

    const files = (await readdir(dir)).sort();
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(2);
    const html = await readFile(
      join(
        dir,
        files.find((f) => f.endsWith('.html'))!,
      ),
      'utf8',
    );
    expect(html).toContain('Your tickets for HackMAIT 2026');
    expect(html).toContain('ticket-1.png');
  });

  it.each([
    ['order-expired', { eventTitle: 'Fest', name: 'Asha', bookAgainUrl: '/e/fest' }, 'ended'],
    ['refund-issued', { eventTitle: 'Fest', name: 'Asha', amount: '₹299', reason: 'late' }, '₹299'],
  ] as const)('previews %s, which has no tickets in it', async (template, data, expected) => {
    const dir = await mkdtemp(join(tmpdir(), 'festpass-email-'));

    await consoleProvider(dir, log).send({
      to: { email: 'asha@test.dev', name: 'Asha' },
      template,
      data,
    } as EmailMessage);

    const [file] = await readdir(dir);
    expect(await readFile(join(dir, file!), 'utf8')).toContain(expected);
  });
});
