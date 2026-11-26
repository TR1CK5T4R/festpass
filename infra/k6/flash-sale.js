import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { report } from './report.js';

// A flash sale: arrivals ramp up to RATE booking attempts a second and stay there. Every attempt is a
// different buyer (from pnpm loadtest:setup) asking for one ticket, so there are far more buyers than
// tickets. The only acceptable answers are 201 (booked), 409 (sold out) and 429 (rate limited); any
// other status, a 5xx above all, fails the run. Afterwards, pnpm loadtest:verify checks Postgres.

const API = __ENV.API_URL || 'http://host.docker.internal:4000/api/v1';
const RATE = Number(__ENV.RATE || 300);
const sale = JSON.parse(open('./.data/sale.json'));
const tokens = new SharedArray('tokens', () => JSON.parse(open('./.data/sale.json')).tokens);

// 10 s ramp + 10 s at RATE: 15 x RATE attempts, one per buyer.
const ATTEMPTS = 15 * RATE;
if (ATTEMPTS > tokens.length) {
  throw new Error(
    `RATE=${RATE} needs ${ATTEMPTS} buyers; run pnpm loadtest:setup with USERS=${ATTEMPTS}`,
  );
}

const answers = {
  201: new Counter('booked'),
  409: new Counter('sold_out'),
  429: new Counter('rate_limited'),
};
const unexpected = new Counter('unexpected_status');

// Answers we expect are not "failed requests"; everything else is.
http.setResponseCallback(http.expectedStatuses(201, 409, 429));

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 3000,
      stages: [
        { target: RATE, duration: '10s' },
        { target: RATE, duration: '10s' },
      ],
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    unexpected_status: ['count==0'],
    // Listed so the summary splits latency by answer (always true).
    'http_req_duration{status:201}': ['max>=0'],
    'http_req_duration{status:409}': ['max>=0'],
  },
};

export default function () {
  const token = tokens[exec.scenario.iterationInTest];
  const res = http.post(
    `${API}/events/${sale.eventId}/orders`,
    JSON.stringify({ items: [{ tierId: sale.tierId, qty: 1 }] }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      tags: { name: 'POST /events/:id/orders' },
    },
  );
  const counter = answers[res.status];
  if (counter) counter.add(1);
  else unexpected.add(1, { status: String(res.status) });
  check(res, { 'status is 201, 409 or 429': (r) => r.status in answers });
}

export function handleSummary(data) {
  return {
    '/k6/.data/flash-summary.json': JSON.stringify(data, null, 2),
    stdout: report(data, `flash sale at ${RATE}/s`, {
      '201 booked': 'booked',
      '409 sold out': 'sold_out',
      '429 rate limited': 'rate_limited',
      'any other status': 'unexpected_status',
      '201 answers': 'http_req_duration{status:201}',
      '409 answers': 'http_req_duration{status:409}',
    }),
  };
}
