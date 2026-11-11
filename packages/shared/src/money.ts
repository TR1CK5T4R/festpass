// Money is stored and sent as integer paise; people type and read rupees. These two functions are the
// only place the two meet, so a rounding bug can only live here (and is tested here).

/**
 * "99.99" -> 9999, "299" -> 29900, "0.5" -> 50. Parsed as text, never multiplied as a float:
 * 99.99 * 100 is 9998.999999999998 in floating point, and Math.floor would lose a paisa.
 * Returns null for anything that isn't a plain amount with at most 2 decimals ("1.005", "-5", "1,299").
 */
export function rupeesToPaise(rupees: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(rupees.trim());
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** 9999 -> "99.99", 29900 -> "299.00": the value an input box should show. Integer maths only. */
export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 29900 -> "₹299.00", 12345600 -> "₹1,23,456.00" (Indian digit grouping). For display only. */
export function formatPaise(paise: number): string {
  const [whole, fraction] = paiseToRupees(paise).split('.');
  return `₹${Number(whole).toLocaleString('en-IN')}.${fraction}`;
}
