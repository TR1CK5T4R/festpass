import type { EventStatus, TierView } from '@festpass/shared';

export type TierState =
  | { kind: 'on-sale' }
  | { kind: 'not-yet'; opensAt: string }
  | { kind: 'ended' }
  | { kind: 'sold-out' }
  | { kind: 'closed' };

/**
 * What a tier card should say at `now`. Computed when the page is rendered, so on a cached page it
 * can be up to a minute old; it is a hint, and the booking endpoint re-checks everything.
 */
export function tierState(
  tier: Pick<TierView, 'available' | 'saleStartsAt' | 'saleEndsAt'>,
  event: { status: EventStatus; saleStartsAt: string; saleEndsAt: string },
  now: Date,
): TierState {
  if (event.status === 'CLOSED') return { kind: 'closed' };
  if (tier.available <= 0) return { kind: 'sold-out' };
  // A tier without its own window sells for the whole event sale window.
  const opensAt = tier.saleStartsAt ?? event.saleStartsAt;
  if (now < new Date(opensAt)) return { kind: 'not-yet', opensAt };
  if (now >= new Date(tier.saleEndsAt ?? event.saleEndsAt)) return { kind: 'ended' };
  return { kind: 'on-sale' };
}
