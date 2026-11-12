import type { NextConfig } from 'next';
import { z } from 'zod';

// One .env for the whole repo: Next only reads apps/web/.env* by itself, so load the root file too.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment
}

// Checked whenever `next dev`, `next build` or `next start` loads this file, so a missing or malformed
// value stops the app with a readable list instead of breaking some later request.
const parsed = z
  .object({
    NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000/api/v1'),
    REVALIDATE_SECRET: z.string().min(32),
    S3_PUBLIC_URL: z.url(),
  })
  .safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment variables:\n${problems.join('\n')}\nSee .env.example.`);
}
const storage = new URL(parsed.data.S3_PUBLIC_URL.replace(/\/+$/, '') + '/');

const nextConfig: NextConfig = {
  // packages/shared is TypeScript source in development (see its "development" export condition).
  transpilePackages: ['@festpass/shared'],
  images: {
    // Next resizes and converts banners (WebP/AVIF) only when they come from our storage bucket.
    remotePatterns: [new URL('**', storage)],
    // The optimizer refuses private and loopback addresses by default (SSRF protection), and local
    // storage is on localhost. Allowed only in that case; in production storage is a public domain.
    dangerouslyAllowLocalIP: ['localhost', '127.0.0.1'].includes(storage.hostname),
  },
};

export default nextConfig;
