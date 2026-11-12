import { describe, expect, it } from 'vitest';
import { tierState } from './tier-state';

const event = {
  status: 'PUBLISHED' as const,
  saleStartsAt: '2026-11-10T06:30:00.000Z',
  saleEndsAt: '2026-12-01T18:29:00.000Z',
};
const tier = { available: 10, saleStartsAt: null, saleEndsAt: null };
const at = (iso: string) => new Date(iso);

describe('tierState', () => {
  it('follows the event sale window when the tier has none', () => {
    expect(tierState(tier, event, at('2026-11-10T06:29:59Z'))).toEqual({
      kind: 'not-yet',
      opensAt: event.saleStartsAt,
    });
    expect(tierState(tier, event, at('2026-11-10T06:30:00Z'))).toEqual({ kind: 'on-sale' });
    expect(tierState(tier, event, at('2026-12-01T18:29:00Z'))).toEqual({ kind: 'ended' });
  });

  it("uses the tier's own window (early bird)", () => {
    const earlyBird = { ...tier, saleEndsAt: '2026-11-15T18:29:00.000Z' };
    expect(tierState(earlyBird, event, at('2026-11-20T00:00:00Z'))).toEqual({ kind: 'ended' });
  });

  it('closed beats sold out, which beats the window', () => {
    const soldOut = { ...tier, available: 0 };
    expect(tierState(soldOut, event, at('2026-11-12T00:00:00Z'))).toEqual({ kind: 'sold-out' });
    expect(tierState(soldOut, { ...event, status: 'CLOSED' }, at('2026-11-12T00:00:00Z'))).toEqual({
      kind: 'closed',
    });
  });
});
