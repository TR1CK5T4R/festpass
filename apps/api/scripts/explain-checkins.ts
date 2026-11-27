import { randomUUID } from 'node:crypto';

// explain() for the check-in dashboard's aggregation (checkinPipeline in packages/mongo/src/analytics.ts),
// on 100,000 generated scans spread over 50 events in a separate festpass_perf Mongo database. Run with
// the { meta.eventId: 1, ts: 1 } index, then forced to ignore it ({ $natural: 1 }), on the same data.
// Run: pnpm perf:explain-mongo

const EVENTS = 50;
const SCANS = 100_000;
const RUNS = 7;

const uri = new URL(process.env.MONGODB_URI!);
uri.pathname = '/festpass_perf';
const { checkinPipeline, connectMongo, disconnectMongo, ScanEvent } =
  await import('@festpass/mongo');
await connectMongo(uri.href);
if (ScanEvent.db.name !== 'festpass_perf') throw new Error(`refusing to use ${ScanEvent.db.name}`);

// A seeded random generator, so every rebuild makes the same data.
let seed = 23;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

const eventIds = Array.from(
  { length: EVENTS },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);
// REBUILD=1 regenerates the data.
if (process.env.REBUILD || (await ScanEvent.estimatedDocumentCount()) !== SCANS) {
  await ScanEvent.deleteMany({});
  const colleges = ['MAIT', 'DTU', 'NSUT', 'IIIT Delhi', 'IPU', null];
  const branches = ['CSE', 'IT', 'ECE', 'ME', null];
  // Event 0 is the big one (about 1 in 10 scans); the rest share what's left.
  const docs = Array.from({ length: SCANS }, () => {
    const event = random() < 0.1 ? 0 : 1 + Math.floor(random() * (EVENTS - 1));
    const opens = Date.UTC(2026, 11, 1 + (event % 28), 4, 0);
    return {
      ts: new Date(opens + Math.floor(random() * 4 * 3_600_000)),
      meta: {
        eventId: eventIds[event]!,
        type: random() < 0.9 ? 'GATE' : 'BOOTH',
        gateOrBoothId: pick(['main', 'north']),
      },
      ticketId: randomUUID(),
      scannerUserId: randomUUID(),
      deviceId: 'perf',
      result: random() < 0.93 ? 'ACCEPTED' : pick(['DUPLICATE', 'INVALID', 'REVOKED']),
      offline: random() < 0.05,
      college: pick(colleges),
      branch: pick(branches),
      graduationYear: pick([2025, 2026, 2027, 2028, null]),
      tierName: pick(['Early bird', 'Regular', 'VIP']),
    };
  });
  // In time order, as scans really arrive: the time-series collection then fills each bucket instead
  // of opening a new one for almost every document.
  docs.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  for (let i = 0; i < docs.length; i += 10_000)
    await ScanEvent.insertMany(docs.slice(i, i + 10_000));
}
const buckets = await ScanEvent.db.db!.collection('system.buckets.scan_events').countDocuments();
const sample = eventIds[0]!;
const sampleScans = await ScanEvent.countDocuments({ 'meta.eventId': sample });
console.log(
  `MongoDB ${(await ScanEvent.db.db!.admin().serverInfo()).version}; ${SCANS} scans in ${buckets} buckets; sample event has ${sampleScans}`,
);

type Stats = {
  executionTimeMillis: number;
  totalKeysExamined: number;
  totalDocsExamined: number;
  nReturned: number;
};
type Plan = { stage: string; indexName?: string; inputStage?: Plan; inputStages?: Plan[] };
const stages = (p: Plan | undefined): string =>
  !p
    ? ''
    : `${p.stage}${p.indexName ? `(${p.indexName})` : ''}${p.inputStage ? ` <- ${stages(p.inputStage)}` : ''}`;

for (const [label, hint] of [
  ['with the { meta.eventId, ts } index', undefined],
  ['forced collection scan ($natural)', { $natural: 1 }],
] as const) {
  const pipeline = checkinPipeline(sample, 15);
  const aggregate = () => {
    const a = ScanEvent.aggregate(pipeline);
    return hint ? a.hint(hint) : a;
  };
  const explain = (await aggregate().explain('executionStats')) as unknown as {
    stages: {
      $cursor?: {
        queryPlanner: { winningPlan: Plan & { queryPlan?: Plan } };
        executionStats: Stats;
      };
    }[];
  };
  const cursor = explain.stages.find((s) => s.$cursor)!.$cursor!;
  const plan = cursor.queryPlanner.winningPlan.queryPlan ?? cursor.queryPlanner.winningPlan;
  const s = cursor.executionStats;
  const times: number[] = [];
  await aggregate();
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await aggregate();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`\n=== ${label}`);
  console.log(`plan: ${stages(plan)}`);
  console.log(
    `buckets examined: ${s.totalDocsExamined}, index keys examined: ${s.totalKeysExamined}, buckets returned: ${s.nReturned}`,
  );
  console.log(
    `whole aggregation: median ${times[RUNS >> 1]!.toFixed(1)} ms (min ${times[0]!.toFixed(1)}, max ${times.at(-1)!.toFixed(1)}), ${RUNS} runs`,
  );
}
await disconnectMongo();
