import type { NextConfig } from 'next';

// One .env for the whole repo: Next only reads apps/web/.env* by itself, so load the root file too.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment
}

const nextConfig: NextConfig = {
  // packages/shared is TypeScript source in development (see its "development" export condition).
  transpilePackages: ['@festpass/shared'],
};

export default nextConfig;
