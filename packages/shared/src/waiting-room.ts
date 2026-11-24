// The waiting room's contract, shared by the API and the web app.

/** How POST /orders receives the admission token (lowercase: that's how Node reads headers). */
export const ADMISSION_HEADER = 'x-admission-token';

/** Long enough to choose tickets and book; short enough that an unused place doesn't linger. */
export const ADMISSION_TOKEN_TTL_SECONDS = 5 * 60;

/** Where a user stands. The server holds all of it, so a reload or a second tab sees the same thing. */
export type QueueStatus =
  /** Queue mode is off: go straight to booking. */
  | { state: 'not_required' }
  | { state: 'not_joined' }
  /** position starts at 1, for the next person in. */
  | { state: 'waiting'; position: number; estimatedWaitSeconds: number }
  | { state: 'admitted'; token: string; expiresAt: string };
