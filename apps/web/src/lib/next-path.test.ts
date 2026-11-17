import { describe, expect, it } from 'vitest';
import { safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('keeps a path on this site', () => {
    expect(safeNextPath('/book/hackmait-2026?tier=abc')).toBe('/book/hackmait-2026?tier=abc');
  });

  it.each([
    null,
    '',
    'https://evil.example',
    '//evil.example/x',
    '/\\evil.example',
    'javascript:alert(1)',
  ])('falls back to the dashboard for %j', (next) => {
    expect(safeNextPath(next)).toBe('/dashboard');
  });
});
