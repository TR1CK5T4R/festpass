// A short plain-text summary (k6's own is replaced once handleSummary is defined), plus the full JSON.

const ms = (v) => (v === undefined ? '-' : `${v.toFixed(1)} ms`);

function latency(data, metric) {
  const v = data.metrics[metric]?.values;
  if (!v) return null;
  return `p50 ${ms(v.med)}, p95 ${ms(v['p(95)'])}, p99 ${ms(v['p(99)'])}, max ${ms(v.max)}`;
}

export function report(data, name, extra = {}) {
  const m = data.metrics;
  const seconds = data.state.testRunDurationMs / 1000;
  const lines = [
    `${name}: ${m.http_reqs.values.count} requests in ${seconds.toFixed(1)} s = ${m.http_reqs.values.rate.toFixed(1)} req/s overall`,
    `latency, all requests: ${latency(data, 'http_req_duration')}`,
    `failed requests (not an expected status): ${(m.http_req_failed.values.rate * 100).toFixed(2)}%`,
    `checks passed: ${(m.checks.values.rate * 100).toFixed(2)}%`,
  ];
  for (const [label, metric] of Object.entries(extra)) {
    if (metric.startsWith('http_req_duration')) {
      const line = latency(data, metric);
      if (line) lines.push(`latency, ${label}: ${line}`);
    } else lines.push(`${label}: ${m[metric]?.values.count ?? 0}`);
  }
  return `\n${lines.join('\n')}\n`;
}
