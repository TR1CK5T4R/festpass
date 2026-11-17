import { describe, expect, it } from 'vitest';
import { bookingKey, forgetBookingKeys } from './booking';

/** A tiny in-memory Storage: Vitest runs these tests in Node, which has no sessionStorage. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  // Object.keys(storage) lists the stored names, like the browser's.
  return new Proxy(store, {
    ownKeys: () => [...data.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }) as Storage;
}

describe('bookingKey', () => {
  it('reuses the key for retries of the same attempt', () => {
    const store = memoryStorage();
    const first = bookingKey('hackmait', 'tier-a', 2, store);
    expect(bookingKey('hackmait', 'tier-a', 2, store)).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a different tier or quantity is a different request with its own key', () => {
    const store = memoryStorage();
    const key = bookingKey('hackmait', 'tier-a', 2, store);
    expect(bookingKey('hackmait', 'tier-a', 3, store)).not.toBe(key);
    expect(bookingKey('hackmait', 'tier-b', 2, store)).not.toBe(key);
  });

  it('after the hold ends, booking again gets a new key', () => {
    const store = memoryStorage();
    const key = bookingKey('hackmait', 'tier-a', 2, store);
    const other = bookingKey('robowars', 'tier-c', 1, store);
    forgetBookingKeys('hackmait', store);
    expect(bookingKey('hackmait', 'tier-a', 2, store)).not.toBe(key);
    expect(bookingKey('robowars', 'tier-c', 1, store)).toBe(other);
  });
});
