import { z } from 'zod';

// Every variable the API reads, in one place. A missing or malformed value stops the process at startup
// with a readable list, instead of failing later on the first request that happens to need it.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  MONGODB_URI: z.url(),
  // HS256 is only as strong as its secret: 32+ characters, e.g. `openssl rand -base64 48`.
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Browser origins allowed to call the API with cookies, comma-separated (e.g. the web app).
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) => s.split(',').map((o) => o.trim()))
    .pipe(z.array(z.url())),
  // S3-compatible storage: SeaweedFS locally, Cloudflare R2 in production (region "auto" there).
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Base URL that public objects (banners) are read from, without a trailing slash.
  S3_PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n${problems.join('\n')}\nSee .env.example.`);
  }
  return result.data;
}

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export const env = loadEnv();
