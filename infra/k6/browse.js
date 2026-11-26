import { check } from 'k6';
import http from 'k6/http';
import { report } from './report.js';

// Many people reading one event page at once: RATE requests a second (default 1000) for 30 s against
// GET /events/:slug, the read behind the event page and the booking page. Answers come from the Redis
// cache (30 s) with tickets left read from the booking gate, so Postgres sees about one query per 30 s.

const API = __ENV.API_URL || 'http://host.docker.internal:4000/api/v1';
const RATE = Number(__ENV.RATE || 1000);
const { slug } = JSON.parse(open('./.data/sale.json'));

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
};

export default function () {
  const res = http.get(`${API}/events/${slug}`, {
    headers: { 'Accept-Encoding': 'gzip' },
    tags: { name: 'GET /events/:slug' },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return {
    '/k6/.data/browse-summary.json': JSON.stringify(data, null, 2),
    stdout: report(data, `browse at ${RATE}/s`),
  };
}
