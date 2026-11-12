// The API stores and returns UTC; <input type="datetime-local"> shows and returns wall-clock time with no
// zone. These convert between the two in the browser's own time zone.

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-12-12T04:30:00.000Z" -> "2026-12-12T10:00" (in IST). */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-12-12T10:00" -> "2026-12-12T04:30:00.000Z". Anything unparseable is passed on for the schema to reject. */
export function fromLocalInput(local: string): string {
  const d = new Date(local);
  return local && !Number.isNaN(d.getTime()) ? d.toISOString() : local;
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * For server-rendered pages: "Fri, 4 Dec, 2026, 10:00 am IST". Fixed to India time, because the
 * server's own time zone (often UTC in production) says nothing about where the reader is.
 */
export const formatEventTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
