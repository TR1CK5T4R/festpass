import { describe, expect, it } from 'vitest';
import { formatPaise, paiseToRupees, rupeesToPaise } from '../src/money.ts';

describe('rupeesToPaise', () => {
  it.each([
    ['99.99', 9999], // 99.99 * 100 would be 9998.999999999998 as a float
    ['0.29', 29], // 0.29 * 100 = 28.999999999999996
    ['1.1', 110], // one decimal means tens of paise, not 1 paisa
    ['0.07', 7],
    ['299', 29900],
    ['0', 0],
    ['  5.50 ', 550],
    ['100000', 10_000_000],
  ])('%s -> %i', (input, paise) => {
    expect(rupeesToPaise(input)).toBe(paise);
  });

  it.each(['', ' ', '1.005', '-5', '1,299', '₹99', '.5', '5.', 'abc', '1e3', '99999999999999999'])(
    'rejects %j instead of guessing',
    (input) => {
      expect(rupeesToPaise(input)).toBeNull();
    },
  );
});

describe('paiseToRupees and formatPaise', () => {
  it('formats without floating point', () => {
    expect(paiseToRupees(9999)).toBe('99.99');
    expect(paiseToRupees(10)).toBe('0.10');
    expect(paiseToRupees(29900)).toBe('299.00');
    expect(paiseToRupees(-150)).toBe('-1.50');
    expect(formatPaise(12_345_600)).toBe('₹1,23,456.00');
    expect(formatPaise(0)).toBe('₹0.00');
  });

  it('round-trips every amount from ₹0.00 to ₹1,000.00', () => {
    for (let paise = 0; paise <= 100_000; paise++) {
      expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
    }
  });
});
