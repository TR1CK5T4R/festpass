import { z } from 'zod';

// Every variable the API reads, in one place. A missing or malformed value stops the process at startup
// with a readable list, instead of failing later on the first request that happens to need it.
// A rate limit as "<burst>/<per minute>": 5/6 allows 5 requests at once, then 6 a minute (one every 10 s).
const rateLimit = (fallback: string) =>
  z
    .string()
    .regex(/^\d+\/\d+(\.\d+)?$/, 'Use <burst>/<per minute>, e.g. 5/6')
    .default(fallback)
    .transform((s) => {
      const [capacity, perMinute] = s.split('/').map(Number) as [number, number];
      return { capacity, refillPerSec: perMinute / 60 };
    })
    .refine((l) => l.capacity >= 1 && l.refillPerSec > 0, 'Burst and rate must be above 0');

// `KEY=` in .env arrives as an empty string; for optional values that means "not set".
const blankAsUnset = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
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
    // How long a booking holds its tickets before they go back on sale if unpaid. Fractions are allowed
    // so tests can use a 2-second hold (0.034).
    HOLD_MINUTES: z.coerce.number().positive().max(60).default(10),
    // Token-bucket limits per endpoint. Login counts per IP + email, register per IP (generous: a whole
    // campus can share one public IP), orders and presign per user.
    RATE_LIMIT_LOGIN: rateLimit('5/5'),
    RATE_LIMIT_REGISTER: rateLimit('20/10'),
    RATE_LIMIT_ORDERS: rateLimit('10/30'),
    RATE_LIMIT_PRESIGN: rateLimit('10/10'),
    // Razorpay, test mode only: a live key (rzp_live_...) is refused at startup. Optional so the app runs
    // without an account; POST /orders/:id/pay answers 503 until both are set.
    RAZORPAY_KEY_ID: z.preprocess(
      blankAsUnset,
      z
        .string()
        .startsWith('rzp_test_', 'Only Razorpay test keys (rzp_test_...) are allowed')
        .optional(),
    ),
    RAZORPAY_KEY_SECRET: z.preprocess(blankAsUnset, z.string().optional()),
    // Chosen by us and entered in Razorpay's webhook settings; signs every webhook. Without it,
    // POST /webhooks/razorpay answers 503 (Razorpay keeps retrying until it is set).
    RAZORPAY_WEBHOOK_SECRET: z.preprocess(blankAsUnset, z.string().min(16).optional()),
    // Who may open the job dashboard (Bull Board) at /admin/queues, comma-separated. Empty: nobody.
    ADMIN_EMAILS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.email())),
    // The web app's on-demand revalidation route, called when a public event changes. Same secret on both sides.
    WEB_REVALIDATE_URL: z.url().default('http://localhost:3000/api/revalidate'),
    REVALIDATE_SECRET: z.string().min(32),
    // S3-compatible storage: SeaweedFS locally, Cloudflare R2 in production (region "auto" there).
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    // Base URL that public objects (banners) are read from, without a trailing slash.
    S3_PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  })
  .refine((e) => !e.RAZORPAY_KEY_ID === !e.RAZORPAY_KEY_SECRET, {
    message: 'Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or neither',
    path: ['RAZORPAY_KEY_SECRET'],
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
