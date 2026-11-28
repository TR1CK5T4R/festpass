import { Redis } from 'ioredis';

// Demo data for the analytics dashboard of the seeded event (mait-alumni-meet-2026), so its charts
// have something to show: 160 demo buyers from a handful of colleges, paid orders spread over the
// first ten days of the sale, and gate scans on the event day. Run `pnpm db:seed` first, then
// `pnpm demo:analytics`. Safe to run again: it removes its own previous orders, tickets and scans
// (demo-buyer-*@festpass.dev, deviceId "demo-analytics") and builds the same data from a fixed seed.
// The scans are dated on the event day (12 Dec 2026), which is still ahead: they are made up.

const SLUG = 'mait-alumni-meet-2026';
const BUYERS = 160;
const DEVICE = 'demo-analytics';

const { prisma } = await import('@festpass/db');
const { reconcileInventory } = await import('@festpass/db/inventory');
const { connectMongo, disconnectMongo, ScanEvent } = await import('@festpass/mongo');
type ScanEventData = import('@festpass/mongo').ScanEventData;

let seed = 2026;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

const event = await prisma.event.findUnique({
  where: { slug: SLUG },
  include: { tiers: true, org: { include: { members: true } } },
});
if (!event) throw new Error(`no event ${SLUG}: run pnpm db:seed first`);
const tier = (name: string) => event.tiers.find((t) => t.name === name)!;
const scanner = event.org.members.find((m) => m.role === 'SCANNER') ?? event.org.members[0]!;

// Buyers: who they are is what the attendee breakdown shows.
const colleges = ['MAIT', 'MAIT', 'MAIT', 'DTU', 'NSUT', 'IIIT Delhi', 'GGSIPU'];
const branches = ['CSE', 'CSE', 'IT', 'ECE', 'EEE', 'ME'];
await prisma.user.createMany({
  data: Array.from({ length: BUYERS }, (_, i) => ({
    email: `demo-buyer-${String(i).padStart(3, '0')}@festpass.dev`,
    name: `Demo Buyer ${i}`,
    passwordHash: 'x',
    college: random() < 0.08 ? null : pick(colleges),
    branch: random() < 0.08 ? null : pick(branches),
    graduationYear: random() < 0.05 ? null : pick([2025, 2026, 2026, 2027, 2027, 2028]),
  })),
  skipDuplicates: true,
});
const buyers = await prisma.user.findMany({
  where: { email: { startsWith: 'demo-buyer-' } },
  orderBy: { email: 'asc' },
});

// Start clean: this script's own orders (and their tickets) for this event, and its scans.
const old = await prisma.order.findMany({
  where: { eventId: event.id, userId: { in: buyers.map((b) => b.id) } },
  select: { id: true },
});
await prisma.ticket.deleteMany({ where: { orderId: { in: old.map((o) => o.id) } } });
await prisma.order.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
await connectMongo(process.env.MONGODB_URI!);
await ScanEvent.deleteMany({ 'meta.eventId': event.id, deviceId: DEVICE });

// Orders over the first ten days of the sale (from 1 Nov 10:00 IST): a launch-day rush, a quiet
// middle, a pick-up near the end. Early bird only on the first three days. One in ten expires unpaid.
const dayWeights = [30, 14, 9, 5, 3, 4, 6, 5, 9, 15];
const saleOpens = Date.UTC(2026, 10, 1, 4, 30);
let ticketNo = 0;
const tickets: { id: string; userId: string; tierName: string }[] = [];
for (const buyer of buyers) {
  let r = random() * dayWeights.reduce((a, b) => a + b, 0);
  let day = 0;
  while (r > dayWeights[day]!) r -= dayWeights[day++]!;
  const createdAt = new Date(saleOpens + day * 86_400_000 + Math.floor(random() * 12 * 3_600_000));
  const t = tier(day < 3 && random() < 0.6 ? 'Early bird' : random() < 0.85 ? 'Regular' : 'VIP');
  const qty = random() < 0.7 ? 1 : 2;
  const status = random() < 0.1 ? 'EXPIRED' : 'TICKETED';
  const order = await prisma.order.create({
    data: {
      userId: buyer.id,
      eventId: event.id,
      status,
      amountPaise: qty * t.pricePaise,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
      createdAt,
      items: { create: { tierId: t.id, qty, unitPricePaise: t.pricePaise } },
    },
  });
  if (status !== 'TICKETED') continue;
  for (let seq = 1; seq <= qty; seq++) {
    const ticket = await prisma.ticket.create({
      data: {
        orderId: order.id,
        eventId: event.id,
        tierId: t.id,
        ownerUserId: buyer.id,
        seq,
        code: `DEMO-${String(++ticketNo).padStart(4, '0')}`,
      },
    });
    tickets.push({ id: ticket.id, userId: buyer.id, tierName: t.name });
  }
}

// sold_count must equal what live orders hold (the load tests' invariant), including orders this
// script didn't make.
await prisma.$executeRaw`
  UPDATE ticket_tiers t SET sold_count = COALESCE((
    SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.tier_id = t.id AND o.status IN ('PENDING', 'PAID', 'TICKETED')), 0)
  WHERE t.event_id = ${event.id}::uuid`;

// The event day: gates open 09:30 IST, most people arrive around 10:15, the last by 12:30. About 85%
// come; a few scan twice (DUPLICATE) and a few show a code that doesn't verify (INVALID).
const opens = Date.UTC(2026, 11, 12, 4, 0);
const arrival = () => {
  const spread = (random() + random() + random()) / 3; // bunched in the middle
  return new Date(opens + Math.floor((0.15 + spread * 0.85) * 3 * 3_600_000) - 30 * 60_000);
};
const byId = new Map(buyers.map((b) => [b.id, b]));
const scans: ScanEventData[] = [];
for (const t of tickets) {
  if (random() > 0.85) continue;
  const owner = byId.get(t.userId)!;
  const ts = arrival();
  const base = {
    meta: {
      eventId: event.id,
      type: 'GATE' as const,
      gateOrBoothId: pick(['main', 'main', 'north']),
    },
    ticketId: t.id,
    scannerUserId: scanner.userId,
    deviceId: DEVICE,
    offline: random() < 0.05,
    college: owner.college,
    branch: owner.branch,
    graduationYear: owner.graduationYear,
    tierName: t.tierName,
  };
  scans.push({ ...base, ts, result: 'ACCEPTED' as const });
  await prisma.ticket.update({
    where: { id: t.id },
    data: { checkedInAt: ts, checkedInBy: scanner.userId, checkedInScanId: `${DEVICE}-${t.id}` },
  });
  if (random() < 0.06) {
    scans.push({ ...base, ts: new Date(ts.getTime() + 90_000), result: 'DUPLICATE' as const });
  }
}
for (let i = 0; i < 5; i++) {
  scans.push({
    ts: arrival(),
    meta: { eventId: event.id, type: 'GATE' as const, gateOrBoothId: 'main' },
    ticketId: null,
    scannerUserId: scanner.userId,
    deviceId: DEVICE,
    result: 'INVALID' as const,
    offline: false,
    college: null,
    branch: null,
    graduationYear: null,
    tierName: null,
  });
}
// Sponsor booths: the seeded sponsor gets a second booth, and about half the people who came in stop
// by, some twice, mostly mid-morning, so the sponsor dashboard and its heatmap have something to show.
const sponsor = await prisma.sponsor.findFirst({
  where: { eventId: event.id },
  orderBy: { name: 'asc' },
});
if (sponsor) {
  await prisma.booth.upsert({
    where: { sponsorId_name: { sponsorId: sponsor.id, name: 'Demo corner' } },
    update: {},
    create: { sponsorId: sponsor.id, name: 'Demo corner' },
  });
  const booths = await prisma.booth.findMany({
    where: { sponsorId: sponsor.id },
    orderBy: { name: 'asc' },
  });
  for (const entry of scans.filter((s) => s.result === 'ACCEPTED')) {
    if (random() > 0.5) continue;
    const trips = random() < 0.2 ? 2 : 1;
    for (let trip = 0; trip < trips; trip++) {
      scans.push({
        ...entry,
        ts: new Date(entry.ts.getTime() + (20 + Math.floor(random() * 150)) * 60_000),
        meta: { eventId: event.id, type: 'BOOTH' as const, gateOrBoothId: pick(booths).id },
        offline: false,
      });
    }
  }
}
await ScanEvent.insertMany(scans);

// The booking gate learns the new stock, so the event page shows the right numbers at once.
const redis = new Redis(process.env.REDIS_URL!);
await reconcileInventory(redis, { eventId: event.id });
await redis.quit();

const entered = scans.filter((s) => s.result === 'ACCEPTED' && s.meta.type === 'GATE').length;
const boothVisits = scans.filter((s) => s.meta.type === 'BOOTH').length;
console.log(
  `demo analytics for ${SLUG}: ${buyers.length} buyers, ${tickets.length} tickets, ${entered} entries, ${scans.length - boothVisits} gate scans, ${boothVisits} booth visits`,
);
await disconnectMongo();
await prisma.$disconnect();
