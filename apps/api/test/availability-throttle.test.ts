import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAvailabilityThrottle } from '../src/sockets/availability.js';

/** A stand-in for SET NX PX: one holder until the window passes on the (fake) clock. */
function fakeClaims() {
  const heldUntil = new Map<string, number>();
  return async (eventId: string, windowMs: number) => {
    if ((heldUntil.get(eventId) ?? 0) > Date.now()) return false;
    heldUntil.set(eventId, Date.now() + windowMs);
    return true;
  };
}

describe('availability throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends at most 2 times a second for 1,000 changes in a second', async () => {
    const sends: number[] = [];
    const changed = createAvailabilityThrottle({
      windowMs: 500,
      claim: fakeClaims(),
      send: () => sends.push(Date.now()),
    });
    const start = Date.now();

    for (let i = 0; i < 1000; i++) {
      await changed('event-1');
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(500);

    expect(sends.length).toBeLessThanOrEqual(3); // 2 inside the second, plus the trailing one
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends.filter((at) => at - start <= 1000).length).toBeLessThanOrEqual(2);
  });

  it('always sends after the last change, so the final numbers are never lost', async () => {
    const send = vi.fn();
    const changed = createAvailabilityThrottle({ windowMs: 500, claim: fakeClaims(), send });

    await changed('event-1');
    expect(send).not.toHaveBeenCalled(); // it waits, to include whatever else changes in the window

    await vi.advanceTimersByTimeAsync(499);
    await changed('event-1'); // the last change, just before the send: that read will include it
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);

    await changed('event-1'); // the window is over, so this one gets a send of its own
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throttles each event on its own', async () => {
    const send = vi.fn();
    const changed = createAvailabilityThrottle({ windowMs: 500, claim: fakeClaims(), send });

    await changed('event-1');
    await changed('event-2');
    await vi.advanceTimersByTimeAsync(500);

    expect(send.mock.calls.map(([id]) => id).sort()).toEqual(['event-1', 'event-2']);
  });

  it('leaves the send to whichever instance won the claim', async () => {
    const claim = fakeClaims();
    const sends = { a: 0, b: 0 };
    const a = createAvailabilityThrottle({ windowMs: 500, claim, send: () => sends.a++ });
    const b = createAvailabilityThrottle({ windowMs: 500, claim, send: () => sends.b++ });

    await a('event-1');
    await b('event-1');
    await vi.advanceTimersByTimeAsync(500);

    expect(sends).toEqual({ a: 1, b: 0 });
  });
});
