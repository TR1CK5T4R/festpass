import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { connectMongo, disconnectMongo, ScanEvent, type ScanEventData } from '@festpass/mongo';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage, EmailProvider } from '../src/email/provider.js';
import { sendSponsorReport, type WorkerDeps } from '../src/processors.js';

const log = pino({ level: 'silent' });

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
beforeEach(async () => {
  await truncateAll(prisma);
  if (ScanEvent.db.name !== 'festpass_test') throw new Error('tests must use festpass_test');
  await ScanEvent.deleteMany({});
});
afterAll(async () => {
  await prisma.$disconnect();
  await disconnectMongo();
});

function fakeEmail(failFor?: string) {
  const sent: EmailMessage[] = [];
  const email: EmailProvider = {
    send: vi.fn(async (m: EmailMessage) => {
      if (m.to.email === failFor) throw new Error('provider down');
      sent.push(m);
    }),
  };
  const deps: WorkerDeps = { log, email };
  return { sent, deps };
}

/** A closed event with one sponsor (two booths, two users) and scans whose numbers are known. */
async function closedSponsor(status: 'CLOSED' | 'PUBLISHED' = 'CLOSED') {
  const org = await prisma.organization.create({
    data: { name: 'Club', slug: `club-${randomUUID()}` },
  });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'TechFest 2026',
      slug: `techfest-${randomUUID()}`,
      description: '',
      venue: 'Hall',
      startsAt: new Date('2026-12-12T04:30:00Z'),
      endsAt: new Date('2026-12-12T12:30:00Z'),
      saleStartsAt: new Date('2026-11-01T00:00:00Z'),
      saleEndsAt: new Date('2026-12-11T00:00:00Z'),
      status,
    },
  });
  const users = await Promise.all(
    ['asha', 'ravi'].map((name) =>
      prisma.user.create({
        data: { email: `${name}-${randomUUID()}@sponsor.test`, name, passwordHash: 'x' },
      }),
    ),
  );
  const sponsor = await prisma.sponsor.create({
    data: {
      eventId: event.id,
      name: 'CodeCraft Labs',
      tier: 'GOLD',
      booths: { create: [{ name: 'Main stall' }, { name: 'Demo corner' }] },
      members: { create: users.map((u) => ({ userId: u.id })) },
    },
    include: { booths: { orderBy: { name: 'asc' } } },
  });
  const [demo, main] = [sponsor.booths[0]!, sponsor.booths[1]!];
  const scan = (
    type: 'GATE' | 'BOOTH',
    where: string,
    ticketId: string,
    at: string,
  ): ScanEventData => ({
    ts: new Date(at),
    meta: { eventId: event.id, type, gateOrBoothId: where },
    ticketId,
    scannerUserId: randomUUID(),
    deviceId: 'phone',
    result: 'ACCEPTED',
    offline: false,
    college: 'MAIT',
    branch: 'CSE',
    graduationYear: 2027,
    tierName: 'Regular',
  });
  const people = Array.from({ length: 5 }, () => randomUUID());
  await ScanEvent.insertMany([
    // 5 entered; 4 visited a booth, one of them twice.
    ...people.map((t) => scan('GATE', 'main', t, '2026-12-12T04:00:00Z')),
    scan('BOOTH', main.id, people[0]!, '2026-12-12T04:40:00Z'),
    scan('BOOTH', main.id, people[0]!, '2026-12-12T05:40:00Z'),
    scan('BOOTH', main.id, people[1]!, '2026-12-12T04:45:00Z'),
    scan('BOOTH', main.id, people[2]!, '2026-12-12T04:50:00Z'),
    scan('BOOTH', demo.id, people[3]!, '2026-12-12T06:00:00Z'),
  ]);
  return { sponsorId: sponsor.id, users };
}

describe('send-sponsor-report', () => {
  it('emails every sponsor user a PDF, with numbers matching the scans', async () => {
    const { sponsorId, users } = await closedSponsor();
    const { sent, deps } = fakeEmail();

    expect(await sendSponsorReport({ sponsorId }, deps)).toEqual({ sent: 2 });

    expect(sent.map((m) => m.to.email).sort()).toEqual(users.map((u) => u.email).sort());
    const [message] = sent;
    expect(message!.template).toBe('sponsor-report');
    expect(message!.data).toMatchObject({
      sponsorName: 'CodeCraft Labs',
      eventTitle: 'TechFest 2026',
      uniqueVisitors: 4,
      repeatVisitors: 1,
      visits: 5,
      attendance: 5,
      shareOfAttendance: '80%',
    });
    const pdf = message!.attachments![0]!;
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('is idempotent: running again, or twice at once, sends nothing more', async () => {
    const { sponsorId } = await closedSponsor();
    const { sent, deps } = fakeEmail();

    await sendSponsorReport({ sponsorId }, deps);
    await Promise.all([
      sendSponsorReport({ sponsorId }, deps),
      sendSponsorReport({ sponsorId }, deps),
    ]);

    expect(sent).toHaveLength(2);
  });

  it('a failed send throws for a retry, which sends only to who missed it', async () => {
    const { sponsorId, users } = await closedSponsor();
    const flaky = fakeEmail(users[1]!.email);

    await expect(sendSponsorReport({ sponsorId }, flaky.deps)).rejects.toThrow('provider down');
    const retry = fakeEmail();
    await sendSponsorReport({ sponsorId }, retry.deps);

    const everyone = [...flaky.sent, ...retry.sent].map((m) => m.to.email).sort();
    expect(everyone).toEqual(users.map((u) => u.email).sort());
  });

  it('does nothing until the event is closed', async () => {
    const { sponsorId } = await closedSponsor('PUBLISHED');
    const { sent, deps } = fakeEmail();

    expect(await sendSponsorReport({ sponsorId }, deps)).toEqual({ sent: 0 });
    expect(sent).toHaveLength(0);
  });
});
