import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs each webhook: X-Razorpay-Signature = hex(HMAC-SHA256(raw body, webhook secret)).
 *
 * It must be checked against the exact bytes received. Parsing the JSON and serialising it again can
 * change key order, spacing or number formatting, and then a genuine webhook would fail to verify (or
 * a check written that way could be fooled). And the comparison must take the same time however many
 * characters match: `===` stops at the first difference, which lets an attacker who can time
 * responses guess a valid signature one character at a time.
 */
export function isValidSignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(signature);
  // timingSafeEqual needs equal lengths; a valid signature is always 64 hex characters anyway.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** For tests and the simulate script: signs a body the way Razorpay does. */
export const sign = (rawBody: string | Buffer, secret: string) =>
  createHmac('sha256', secret).update(rawBody).digest('hex');
