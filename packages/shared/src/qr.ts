import { verifyAsync } from '@noble/ed25519';
import { z } from 'zod';

// Ticket QR codes: FP1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
//
// Signed with a private key that only the server has; verified with the matching public key, which
// can be printed on every scanner. A forger would need the private key; a scanner that is offline only
// needs the public one. Runs in Node and in the browser (no Node APIs here).

export const QR_PREFIX = 'FP1';

/**
 * Everything the gate needs and nothing about the person: the ticket, the event it is for, the QR
 * version (bumped to revoke old codes) and when it was issued (seconds since epoch). A name or email
 * here would be readable by anyone who sees the code: QR codes are not encrypted, only signed.
 */
export interface TicketQrPayload {
  t: string;
  e: string;
  v: number;
  iat: number;
}

const payloadSchema = z
  .object({
    t: z.uuid(),
    e: z.uuid(),
    v: z.number().int().positive(),
    iat: z.number().int().positive(),
  })
  .strict();

/** The payload for a ticket as stored: the API, the PDF and the email all build it this one way. */
export const ticketQrPayload = (ticket: {
  id: string;
  eventId: string;
  qrVersion: number;
  createdAt: Date;
}): TicketQrPayload => ({
  t: ticket.id,
  e: ticket.eventId,
  v: ticket.qrVersion,
  iat: Math.floor(ticket.createdAt.getTime() / 1000),
});

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Throws on characters that aren't base64url. */
export function base64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The exact bytes that are signed. The prefix is included, so a payload can't be reused in another format. */
export const signedPart = (payloadPart: string) => `${QR_PREFIX}.${payloadPart}`;

export type TicketVerification =
  | { valid: true; payload: TicketQrPayload }
  | { valid: false; reason: 'FORMAT' | 'PREFIX' | 'SIGNATURE' | 'PAYLOAD' };

/**
 * Checks a scanned QR string against the public key (32 raw bytes, base64url). Only proves the server
 * issued it; whether it is still valid (right event, current qrVersion, not used yet) is the gate's
 * check (Day 19).
 */
export async function verifyTicket(qr: string, publicKey: string): Promise<TicketVerification> {
  const parts = qr.trim().split('.');
  if (parts.length !== 3) return { valid: false, reason: 'FORMAT' };
  const [prefix, payloadPart, signaturePart] = parts as [string, string, string];
  if (prefix !== QR_PREFIX) return { valid: false, reason: 'PREFIX' };

  let signature: Uint8Array;
  let key: Uint8Array;
  try {
    signature = base64urlDecode(signaturePart);
    key = base64urlDecode(publicKey);
  } catch {
    return { valid: false, reason: 'FORMAT' };
  }
  if (signature.length !== 64 || key.length !== 32) return { valid: false, reason: 'FORMAT' };

  // zip215: false = strict RFC 8032 rules, the same ones Node's crypto.verify applies.
  const signed = new TextEncoder().encode(signedPart(payloadPart));
  const ok = await verifyAsync(signature, signed, key, { zip215: false }).catch(() => false);
  if (!ok) return { valid: false, reason: 'SIGNATURE' };

  // Parsed only after the signature checks out: nothing from an unverified code is trusted.
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart)));
    const payload = payloadSchema.safeParse(json);
    return payload.success
      ? { valid: true, payload: payload.data }
      : { valid: false, reason: 'PAYLOAD' };
  } catch {
    return { valid: false, reason: 'PAYLOAD' };
  }
}
