'use client';

import {
  formatPaise,
  type CheckinAnalytics,
  type CountBy,
  type SalesAnalytics,
} from '@festpass/shared';
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/form-errors';
import { useApiData } from '@/lib/use-api-data';

// The organizer's analytics: four charts over numbers the API aggregates in Postgres and MongoDB.
// Every chart is one series in the brand blue (checked against the white surface for contrast), so
// none needs a legend; each card's title names what is plotted, and each has a table view, so no
// number is only reachable by hovering.

const INK = '#0f172a';
const MUTED = '#5b6577';
const LINE = '#e2e8f0';
const SERIES = '#3a54d6'; // brand-600
const TRACK = '#dde6ff'; // brand-100: the unfilled part of a tier
const axisTick = { fill: MUTED, fontSize: 12 };

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayAndClock = (iso: string) =>
  `${new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${clock(iso)}`;
/** Times alone are ambiguous when the entries span more than one day, so the day is added then. */
const timeLabel = (timeline: { at: string }[]) =>
  timeline.length > 0 &&
  new Date(timeline[0]!.at).toDateString() !== new Date(timeline.at(-1)!.at).toDateString()
    ? dayAndClock
    : clock;
const notGiven = (value: string | number | null) => (value === null ? 'Not given' : String(value));

/** Value first and strong, label after: the reader already knows the series and wants the number. */
function TooltipBox({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-control border border-line bg-surface px-3 py-2 text-sm shadow-sm">
      <p className="mb-1 text-xs text-muted">{title}</p>
      {rows.map(([value, label]) => (
        <p key={label}>
          <span className="font-semibold text-ink">{value}</span>{' '}
          <span className="text-muted">{label}</span>
        </p>
      ))}
    </div>
  );
}

function tooltip<T>(render: (row: T) => { title: string; rows: [string, string][] }) {
  return function Content({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: ReadonlyArray<{ payload?: unknown }>;
  }) {
    const row = payload?.[0]?.payload as T | undefined;
    return active && row ? <TooltipBox {...render(row)} /> : null;
  };
}

function ChartCard({
  title,
  subtitle,
  controls,
  table,
  children,
}: {
  title: string;
  subtitle?: string;
  controls?: ReactNode;
  table: { head: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {controls}
      </div>
      {table.rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">No data yet.</p>
      ) : (
        children
      )}
      {table.rows.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Show as a table</summary>
          <table className="mt-2 w-full text-left">
            <thead>
              <tr className="border-b border-line text-muted">
                {table.head.map((h) => (
                  <th key={h} className="py-1 pr-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="py-1 pr-3 tabular-nums">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </Card>
  );
}

function SalesOverTime({ sales }: { sales: SalesAnalytics }) {
  return (
    <ChartCard
      title="Tickets sold per day"
      subtitle="Paid tickets, by the day they were booked (India time)"
      table={{
        head: ['Day', 'Tickets', 'Revenue'],
        rows: sales.days.map((d) => [shortDay(d.day), d.tickets, formatPaise(d.revenuePaise)]),
      }}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={sales.days} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={LINE} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            minTickGap={16}
          />
          <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: LINE, opacity: 0.5 }}
            content={tooltip<SalesAnalytics['days'][number]>((d) => ({
              title: shortDay(d.day),
              rows: [
                [String(d.tickets), d.tickets === 1 ? 'ticket' : 'tickets'],
                [formatPaise(d.revenuePaise), 'revenue'],
              ],
            }))}
          />
          <Bar
            isAnimationActive={false}
            dataKey="tickets"
            fill={SERIES}
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function TierFill({ sales }: { sales: SalesAnalytics }) {
  const rows = sales.tiers.map((t) => ({
    ...t,
    percent: t.capacity === 0 ? 0 : Math.round((t.paid / t.capacity) * 100),
  }));
  return (
    <ChartCard
      title="Tier fill"
      subtitle="Paid tickets as a share of each tier's capacity"
      table={{
        head: ['Tier', 'Paid', 'Held', 'Capacity', 'Revenue'],
        rows: rows.map((t) => [t.name, t.paid, t.held, t.capacity, formatPaise(t.revenuePaise)]),
      }}
    >
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 48)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 72, left: 8, bottom: 0 }}>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ ...axisTick, fill: INK }}
            tickLine={false}
            axisLine={false}
            width={88}
          />
          <Tooltip
            cursor={false}
            content={tooltip<(typeof rows)[number]>((t) => ({
              title: t.name,
              rows: [
                [`${t.paid} of ${t.capacity}`, 'paid'],
                [String(t.held), 'held, not paid yet'],
                [formatPaise(t.revenuePaise), 'revenue'],
              ],
            }))}
          />
          <Bar
            isAnimationActive={false}
            dataKey="percent"
            fill={SERIES}
            background={{ fill: TRACK, radius: 4 }}
            radius={[0, 4, 4, 0]}
            barSize={16}
            label={{
              position: 'right',
              fill: INK,
              fontSize: 12,
              formatter: (v: unknown) => `${String(v)}%`,
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function CheckinTimeline({
  checkins,
  bucket,
  onBucket,
}: {
  checkins: CheckinAnalytics;
  bucket: number;
  onBucket: (minutes: number) => void;
}) {
  const { peak } = checkins;
  const label = timeLabel(checkins.timeline);
  return (
    <ChartCard
      title="Entries at the gate"
      subtitle={
        peak
          ? `Busiest: ${label(peak.at)}, ${peak.count} people in ${bucket} minutes (${peak.perMinute} a minute)`
          : 'Accepted gate scans over time'
      }
      controls={
        <Select
          label="Every"
          value={bucket}
          onChange={(e) => onBucket(Number(e.target.value))}
          className="w-28"
        >
          <option value={15}>15 minutes</option>
          <option value={5}>5 minutes</option>
        </Select>
      }
      table={{
        head: ['From', 'Entries'],
        rows: checkins.timeline.map((b) => [label(b.at), b.count]),
      }}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={checkins.timeline} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={LINE} />
          <XAxis
            dataKey="at"
            tickFormatter={label}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: LINE, opacity: 0.5 }}
            content={tooltip<CheckinAnalytics['timeline'][number]>((b) => ({
              title: `From ${label(b.at)}`,
              rows: [[String(b.count), b.count === 1 ? 'entry' : 'entries']],
            }))}
          />
          <Bar
            isAnimationActive={false}
            dataKey="count"
            fill={SERIES}
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const DIMENSIONS = {
  college: 'College',
  branch: 'Branch',
  graduationYear: 'Graduation year',
  tier: 'Ticket tier',
} as const;
type Dimension = keyof typeof DIMENSIONS;

function AttendeeBreakdown({ checkins }: { checkins: CheckinAnalytics }) {
  const [dimension, setDimension] = useState<Dimension>('college');
  const counts = checkins.breakdown[dimension] as CountBy<string | number | null>[];
  const rows = counts.map((c) => ({ label: notGiven(c.value), count: c.count }));
  return (
    <ChartCard
      title="Who came in"
      subtitle={`People who entered, by ${DIMENSIONS[dimension].toLowerCase()}${dimension === 'college' || dimension === 'branch' ? ' (top 10)' : ''}`}
      controls={
        <Select
          label="By"
          value={dimension}
          onChange={(e) => setDimension(e.target.value as Dimension)}
          className="w-40"
        >
          {Object.entries(DIMENSIONS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      }
      table={{ head: [DIMENSIONS[dimension], 'People'], rows: rows.map((r) => [r.label, r.count]) }}
    >
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 36)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, left: 8, bottom: 0 }}>
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...axisTick, fill: INK }}
            tickLine={false}
            axisLine={false}
            width={96}
          />
          <Tooltip
            cursor={{ fill: LINE, opacity: 0.5 }}
            content={tooltip<(typeof rows)[number]>((r) => ({
              title: r.label,
              rows: [[String(r.count), r.count === 1 ? 'person' : 'people']],
            }))}
          />
          <Bar
            isAnimationActive={false}
            dataKey="count"
            fill={SERIES}
            radius={[0, 4, 4, 0]}
            barSize={16}
            label={{ position: 'right', fill: INK, fontSize: 12 }}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Sales and check-in analytics for one event (owners and managers; numbers up to 30 s old). */
export function EventAnalytics({ orgId, eventId }: { orgId: string; eventId: string }) {
  const base = `/orgs/${orgId}/events/${eventId}/analytics`;
  const sales = useApiData<{ sales: SalesAnalytics }>(`${base}/sales`);
  // Both sizes are loaded, so switching between them never blanks the chart while it reloads.
  const by15 = useApiData<{ checkins: CheckinAnalytics }>(`${base}/checkins?bucket=15`);
  const by5 = useApiData<{ checkins: CheckinAnalytics }>(`${base}/checkins?bucket=5`);
  const [bucket, setBucket] = useState(15);
  const checkins = (bucket === 5 ? by5 : by15).data?.checkins ?? by15.data?.checkins;

  const error = sales.error ?? by15.error;
  if (error) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  if (!sales.data || !checkins) return <p className="text-sm text-muted">Loading analytics…</p>;

  const { totals } = sales.data.sales;
  const peak = checkins.peak;
  return (
    <section className="flex flex-col gap-4" aria-label="Analytics">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Analytics</h2>
        <p className="text-xs text-muted">Updated every 30 seconds</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tickets sold" value={totals.tickets.toLocaleString('en-IN')} />
        <Stat label="Revenue" value={formatPaise(totals.revenuePaise)} />
        <Stat
          label="Entered"
          value={checkins.totals.entered.toLocaleString('en-IN')}
          note={
            totals.tickets > 0
              ? `${Math.round((checkins.totals.entered / totals.tickets) * 100)}% of tickets sold`
              : undefined
          }
        />
        <Stat
          label="Peak entry rate"
          value={peak ? `${peak.perMinute} / min` : '–'}
          note={
            peak
              ? `from ${timeLabel(checkins.timeline)(peak.at)}, ${bucket}-minute buckets`
              : 'No entries yet'
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SalesOverTime sales={sales.data.sales} />
        <TierFill sales={sales.data.sales} />
        <CheckinTimeline checkins={checkins} bucket={checkins.bucketMinutes} onBucket={setBucket} />
        <AttendeeBreakdown checkins={checkins} />
      </div>
    </section>
  );
}
