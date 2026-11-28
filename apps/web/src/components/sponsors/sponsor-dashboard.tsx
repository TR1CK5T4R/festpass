'use client';

import type { CountBy, SponsorAnalytics } from '@festpass/shared';
import { Card } from '@/components/ui/card';

// The sponsor's view: counts only. A heatmap of visits per booth per hour, and who visited by branch
// and year, where groups too small to be anonymous are already folded into "Other" by the API.

// One hue, light to dark, for "more visits" (sequential, never a rainbow). The lightest step is the
// empty-looking end; cells with no visits stay the surface colour, so "none" is not a shade.
const RAMP = ['#e3e9ff', '#b9c6fb', '#8197f2', '#4f6bed', '#2e42ad'];
// Text on the two darkest steps is white, on the rest near-black, by the fill's lightness.
const textOn = (step: number) => (step >= 3 ? 'text-white' : 'text-ink');

const istHour = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: true,
  });
const istDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  });
const percent = (share: number | null) => (share === null ? '–' : `${Math.round(share * 100)}%`);
const label = (value: string | number | null) => (value === null ? 'Not given' : String(value));

function Stat({ label: name, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{name}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </Card>
  );
}

function Heatmap({ analytics }: { analytics: SponsorAnalytics }) {
  const { heatmap, booths } = analytics;
  if (heatmap.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No visits yet.</p>;
  }
  // Within one day, every hour from the first visit to the last, so a quiet hour shows as a gap. Over
  // a longer span (visits on several days), only hours with visits, or the grid would be mostly empty.
  const first = Date.parse(heatmap[0]!.hour);
  const last = Date.parse(heatmap.at(-1)!.hour);
  const hours: string[] = [];
  if (last - first <= 24 * 3_600_000) {
    for (let t = first; t <= last; t += 3_600_000) hours.push(new Date(t).toISOString());
  } else {
    hours.push(...new Set(heatmap.map((h) => h.hour)));
  }
  const multiDay = istDay(hours[0]!) !== istDay(hours.at(-1)!);
  const cell = new Map(heatmap.map((h) => [`${h.boothId} ${h.hour}`, h.visits]));
  const max = Math.max(...heatmap.map((h) => h.visits));
  const step = (visits: number) =>
    Math.min(RAMP.length - 1, Math.floor((visits / max) * RAMP.length));

  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-sm">
        <thead>
          <tr>
            <th className="pr-3 text-left font-medium text-muted">Booth</th>
            {hours.map((h) => (
              <th
                key={h}
                scope="col"
                className="min-w-12 px-1 text-center text-xs font-medium text-muted"
              >
                {multiDay && <span className="block">{istDay(h)}</span>}
                {istHour(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {booths.map((booth) => (
            <tr key={booth.id}>
              <th scope="row" className="pr-3 text-left font-medium whitespace-nowrap">
                {booth.name}
              </th>
              {hours.map((h) => {
                const visits = cell.get(`${booth.id} ${h}`) ?? 0;
                return (
                  <td
                    key={h}
                    title={`${booth.name}, from ${istHour(h)}: ${visits} ${visits === 1 ? 'visit' : 'visits'}`}
                    className={`h-9 rounded text-center tabular-nums ${visits === 0 ? 'border border-line text-muted' : textOn(step(visits))}`}
                    style={visits === 0 ? undefined : { backgroundColor: RAMP[step(visits)] }}
                  >
                    {visits === 0 ? '' : visits}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex items-center gap-2 text-xs text-muted">
        Fewer
        {RAMP.map((colour) => (
          <span
            key={colour}
            className="inline-block h-3 w-5 rounded-sm"
            style={{ backgroundColor: colour }}
          />
        ))}
        More visits per hour (India time). Each cell shows its count.
      </p>
    </div>
  );
}

function Bars({
  title,
  rows,
  total,
}: {
  title: string;
  rows: CountBy<string | number | null>[];
  total: number;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No visitors yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {rows.map((r) => (
            <li
              key={label(r.value)}
              className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2"
            >
              <span className="truncate">{label(r.value)}</span>
              <span className="h-4 rounded-r bg-brand-50">
                <span
                  className="block h-4 rounded-r bg-brand-600"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </span>
              <span className="text-right tabular-nums">
                {r.count}
                <span className="text-muted">
                  {' '}
                  ({Math.round((r.count / Math.max(1, total)) * 100)}%)
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SponsorDashboard({ analytics }: { analytics: SponsorAnalytics }) {
  const { totals, booths } = analytics;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Visitors"
          value={totals.uniqueVisitors.toLocaleString('en-IN')}
          note="different people at your booths"
        />
        <Stat
          label="Share of attendance"
          value={percent(totals.shareOfAttendance)}
          note={`of ${totals.attendance.toLocaleString('en-IN')} who came`}
        />
        <Stat
          label="Came back"
          value={totals.repeatVisitors.toLocaleString('en-IN')}
          note="visited more than once"
        />
        <Stat
          label="Visits"
          value={totals.visits.toLocaleString('en-IN')}
          note="every scan at your booths"
        />
      </div>
      <Card className="flex flex-col gap-3">
        <h3 className="font-semibold">Visits by hour</h3>
        <Heatmap analytics={analytics} />
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">
            Visits per booth as a table
          </summary>
          <table className="mt-2 w-full text-left">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-1 font-medium">Booth</th>
                <th className="py-1 font-medium">Visitors</th>
                <th className="py-1 font-medium">Visits</th>
              </tr>
            </thead>
            <tbody>
              {booths.map((b) => (
                <tr key={b.id} className="border-b border-line last:border-0">
                  <td className="py-1">{b.name}</td>
                  <td className="py-1 tabular-nums">{b.uniqueVisitors}</td>
                  <td className="py-1 tabular-nums">{b.visits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Bars
          title="Visitors by branch"
          rows={analytics.breakdown.branch}
          total={totals.uniqueVisitors}
        />
        <Bars
          title="Visitors by graduation year"
          rows={analytics.breakdown.graduationYear}
          total={totals.uniqueVisitors}
        />
      </div>
      <p className="text-xs text-muted">
        Counts only: FestPass never shares names or contact details with sponsors. Any group of
        fewer than {analytics.minGroupSize} people is counted under &ldquo;Other&rdquo;. Numbers
        update every 30 seconds.
      </p>
    </div>
  );
}
