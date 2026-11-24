import type { QueueStatus } from '@festpass/shared';

/** 3 -> "about 3 seconds", 200 -> "about 4 minutes". An estimate, so never more exact than that. */
export function formatWait(seconds: number) {
  if (seconds < 60) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;

/**
 * How long until the next status check. People far back in line ask rarely, so a long line doesn't turn
 * into a flood of requests. The random part stops a crowd that joined together from asking together.
 * The admitted message arrives over the socket; this is what still works if that message is missed.
 */
export function pollDelayMs(status: QueueStatus | null, random = Math.random) {
  const wait = status?.state === 'waiting' ? status.estimatedWaitSeconds * 1000 : 0;
  const base = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, wait / 4));
  return Math.round(base * (0.8 + random() * 0.4));
}
