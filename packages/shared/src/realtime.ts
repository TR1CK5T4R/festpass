import { z } from 'zod';
import type { ScanResult } from './checkins.ts';

// The Socket.IO contract, shared so the API and the web app can't disagree on a name or a payload.

/** public: anyone, availability only. staff: the event's club, for the check-in feed. */
export const joinEventSchema = z.object({
  eventId: z.uuid(),
  room: z.enum(['public', 'staff']),
});
export type JoinEventInput = z.infer<typeof joinEventSchema>;

export type JoinResult =
  | { ok: true }
  | { ok: false; code: 'VALIDATION_FAILED' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL' };

/** The whole message a public room ever gets: numbers about tiers, nothing about people. */
export interface AvailabilityUpdate {
  eventId: string;
  tiers: { id: string; available: number }[];
}

/** One scan for the organizer's feed. Ticket IDs only: the feed doesn't need to name anyone. */
export interface LiveScan {
  ticketId: string | null;
  tierName: string | null;
  gateId: string;
  result: ScanResult;
  offline: boolean;
  ts: string;
}

/** What the dashboard loads first, and again after a reconnect, because it may have missed scans. */
export interface CheckinSummary {
  checkedIn: number;
  totalTickets: number;
  recent: LiveScan[];
}

export interface ServerToClientEvents {
  availability: (update: AvailabilityUpdate) => void;
  scan: (scan: LiveScan) => void;
}

export interface ClientToServerEvents {
  'event:join': (input: JoinEventInput, ack: (result: JoinResult) => void) => void;
}

/** The handshake's answer to a bad or expired token; the client refreshes it and connects again. */
export const SOCKET_UNAUTHORIZED = 'UNAUTHORIZED';
