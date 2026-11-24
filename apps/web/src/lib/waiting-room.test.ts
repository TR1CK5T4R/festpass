import { describe, expect, it } from 'vitest';
import { formatWait, pollDelayMs } from './waiting-room';

const waiting = (estimatedWaitSeconds: number) =>
  ({ state: 'waiting', position: 1, estimatedWaitSeconds }) as const;
const noJitter = () => 0.5;

describe('formatWait', () => {
  it('uses seconds under a minute, and rounded-up minutes after', () => {
    expect(formatWait(1)).toBe('about 1 second');
    expect(formatWait(59)).toBe('about 59 seconds');
    expect(formatWait(60)).toBe('about 1 minute');
    expect(formatWait(61)).toBe('about 2 minutes');
  });
});

describe('pollDelayMs', () => {
  it('asks more often near the front, within limits', () => {
    expect(pollDelayMs(waiting(1), noJitter)).toBe(2_000);
    expect(pollDelayMs(waiting(40), noJitter)).toBe(10_000);
    expect(pollDelayMs(waiting(10_000), noJitter)).toBe(30_000);
  });

  it('spreads a crowd out by up to 20% either way', () => {
    expect(pollDelayMs(waiting(40), () => 0)).toBe(8_000);
    expect(pollDelayMs(waiting(40), () => 1)).toBe(12_000);
  });

  it('retries soon when the last check failed', () => {
    expect(pollDelayMs(null, noJitter)).toBe(2_000);
  });
});
