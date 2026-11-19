import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode, verifyTicket, type TicketQrPayload } from '../src/qr.ts';
import { createTicketSigner, encodeTicket } from '../src/server.ts';

/** A key pair in the formats `pnpm keys:generate` prints. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! };
}

const ticket: TicketQrPayload = {
  t: '7f1c2a60-5b3e-4c1a-9d2f-0a1b2c3d4e5f',
  e: '3e774b32-9120-4ebe-a8f8-77ff8d0b9663',
  v: 1,
  iat: 1_794_000_000,
};
const { privateKey, publicKey } = keyPair();
const encode = createTicketSigner(privateKey);

describe('ticket QR codes', () => {
  it('round-trips: what the server signs, the public key verifies', async () => {
    const qr = encode(ticket);
    expect(qr).toMatch(/^FP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    expect(await verifyTicket(qr, publicKey)).toEqual({ valid: true, payload: ticket });
  });

  it('encodeTicket and a bound signer give the same, deterministic string', () => {
    expect(encodeTicket(ticket, privateKey)).toBe(encode(ticket));
    expect(encode(ticket)).toBe(encode(ticket));
  });

  it('holds no personal data: only ticket ID, event ID, version and issue time', () => {
    const payloadPart = encode(ticket).split('.')[1]!;
    const json = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart)));
    expect(Object.keys(json).sort()).toEqual(['e', 'iat', 't', 'v']);
  });

  it('a tampered payload fails (e.g. a ticket ID changed, or the version bumped by hand)', async () => {
    const [prefix, , signature] = encode(ticket).split('.');
    const forged = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...ticket, v: 2 })));
    expect(await verifyTicket(`${prefix}.${forged}.${signature}`, publicKey)).toEqual({
      valid: false,
      reason: 'SIGNATURE',
    });
  });

  it('a code signed with another key fails', async () => {
    const other = createTicketSigner(keyPair().privateKey);
    expect((await verifyTicket(other(ticket), publicKey)).valid).toBe(false);
  });

  it.each([
    ['a wrong prefix', (qr: string) => qr.replace(/^FP1/, 'FP2'), 'PREFIX'],
    ['a missing part', (qr: string) => qr.split('.').slice(0, 2).join('.'), 'FORMAT'],
    ['a truncated signature', (qr: string) => qr.slice(0, -4), 'FORMAT'],
    ['characters that are not base64url', (qr: string) => `${qr.slice(0, -2)}+/`, 'FORMAT'],
  ])('%s fails', async (_name, mangle, reason) => {
    expect(await verifyTicket(mangle(encode(ticket)), publicKey)).toEqual({ valid: false, reason });
  });

  it('a validly signed payload that is not a ticket fails', async () => {
    // Signed by the real key, but not the shape of a ticket: still rejected.
    const sign = createTicketSigner(privateKey);
    const odd = sign({ ...ticket, t: 'not-a-uuid' });
    expect(await verifyTicket(odd, publicKey)).toEqual({ valid: false, reason: 'PAYLOAD' });
  });
});
