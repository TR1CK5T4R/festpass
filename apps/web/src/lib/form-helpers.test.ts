import { createTierSchema } from '@festpass/shared';
import { describe, expect, it } from 'vitest';
import { fromLocalInput, toLocalInput } from './dates';
import { sharedSchemaResolver, toNumber } from './form-resolver';

const tierResolver = sharedSchemaResolver(
  createTierSchema,
  (v: { name: string; price: string; capacity: string }) => ({
    name: v.name,
    pricePaise: v.price === '99.99' ? 9999 : NaN,
    capacity: toNumber(v.capacity),
  }),
  { pricePaise: 'price' },
);
const run = (values: { name: string; price: string; capacity: string }) =>
  tierResolver(values, undefined, { fields: {}, shouldUseNativeValidation: false });

describe('sharedSchemaResolver', () => {
  it('returns the converted values the API will accept', async () => {
    const result = await run({ name: 'Regular', price: '99.99', capacity: '100' });
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({
      name: 'Regular',
      pricePaise: 9999,
      capacity: 100,
      perUserLimit: 4,
    });
  });

  it("puts the shared schema's messages on the input the user typed in", async () => {
    const result = await run({ name: '', price: 'abc', capacity: '' });
    expect(Object.keys(result.errors).sort()).toEqual(['capacity', 'name', 'price']);
    expect(result.errors.price?.message).toBe('Enter an amount like 299 or 99.99');
    expect(result.errors.capacity?.message).toBe('Enter a whole number');
  });
});

describe('datetime-local conversion', () => {
  it('round-trips through UTC in the local time zone', () => {
    const iso = fromLocalInput('2026-12-12T10:00');
    expect(iso).toMatch(/Z$/);
    expect(toLocalInput(iso)).toBe('2026-12-12T10:00');
  });

  it('leaves empty or invalid input for the schema to reject', () => {
    expect(fromLocalInput('')).toBe('');
    expect(toLocalInput(null)).toBe('');
  });
});
