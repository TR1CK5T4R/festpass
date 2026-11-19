// Prints a new Ed25519 key pair for ticket QR codes, as .env lines.
// Usage: pnpm keys:generate   (paste the output into .env; rotating keys invalidates every existing QR)
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

console.log('# Ticket QR keys, made by `pnpm keys:generate`.');
console.log(
  '# Private: signs QR codes. API and worker only; never in the web app or the repository.',
);
console.log(
  `TICKET_SIGNING_PRIVATE_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}`,
);
console.log(
  '# Public: verifies QR codes, safe to ship to every phone (the scanner uses it offline).',
);
console.log(`NEXT_PUBLIC_TICKET_PUBLIC_KEY=${publicKey.export({ format: 'jwk' }).x}`);
