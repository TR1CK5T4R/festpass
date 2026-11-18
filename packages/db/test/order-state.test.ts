import { describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';
import {
  canTransition,
  ORDER_TRANSITIONS,
  transition,
  type OrderStatus,
} from '../src/order-state.js';

const ALLOWED: [OrderStatus, OrderStatus][] = [
  ['PENDING', 'PAID'],
  ['PENDING', 'EXPIRED'],
  ['PENDING', 'CANCELLED'],
  ['PAID', 'TICKETED'],
  ['EXPIRED', 'PAID'],
  ['EXPIRED', 'REFUNDED'],
  ['PAID', 'REFUNDED'],
];
const STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

describe('order state machine', () => {
  it('allows exactly the listed transitions', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const listed = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(listed);
      }
    }
  });

  it.each([
    ['PAID', 'PENDING'],
    ['TICKETED', 'REFUNDED'],
    ['CANCELLED', 'PAID'],
    ['REFUNDED', 'PAID'],
    ['EXPIRED', 'TICKETED'],
  ] as const)('rejects %s -> %s before touching the database', async (from, to) => {
    await expect(
      transition(prisma as never, '00000000-0000-0000-0000-000000000000', from, to),
    ).rejects.toThrow(`order transition ${from} -> ${to} is not allowed`);
  });

  it('an allowed move on an order not in `from` changes nothing and reports it', async () => {
    const moved = await transition(
      prisma as never,
      '00000000-0000-0000-0000-000000000000',
      'PENDING',
      'PAID',
    );
    expect(moved).toBe(false);
  });
});
