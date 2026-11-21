import { fileURLToPath } from 'node:url';
import { loadTicketPrivateKey } from '@festpass/shared/server';
import { z } from 'zod';

// Every variable the worker reads, checked once at startup like the API's.

const blankAsUnset = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUnset, schema.optional());

const schema = z
  .object({
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    MONGODB_URI: z.url(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Optional: without them, refund jobs fail and wait in Bull Board for a retry.
    RAZORPAY_KEY_ID: optional(z.string().startsWith('rzp_test_')),
    RAZORPAY_KEY_SECRET: optional(z.string()),
    // Signs the QR codes printed in ticket PDFs and emails (same key as the API).
    TICKET_SIGNING_PRIVATE_KEY: z.string().transform((value, ctx) => {
      try {
        return loadTicketPrivateKey(value);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Not an Ed25519 private key; run pnpm keys:generate',
        });
        return z.NEVER;
      }
    }),
    // Storage for ticket PDFs (the same bucket as banners, under a private prefix).
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    // Links inside emails ("see your tickets", "book again").
    PUBLIC_WEB_URL: z
      .url()
      .default('http://localhost:3000')
      .transform((u) => u.replace(/\/+$/, '')),
    // console: no email leaves the machine; each one is logged and saved as an HTML file to look at.
    EMAIL_PROVIDER: z.enum(['console', 'sendgrid']).default('console'),
    EMAIL_PREVIEW_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../.email-previews', import.meta.url))),
    EMAIL_FROM: z.string().default('FestPass <tickets@festpass.dev>'),
    SENDGRID_API_KEY: optional(z.string().startsWith('SG.')),
    SENDGRID_TEMPLATE_TICKET_CONFIRMATION: optional(z.string().startsWith('d-')),
    SENDGRID_TEMPLATE_ORDER_EXPIRED: optional(z.string().startsWith('d-')),
    SENDGRID_TEMPLATE_REFUND_ISSUED: optional(z.string().startsWith('d-')),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER !== 'sendgrid') return;
    for (const name of [
      'SENDGRID_API_KEY',
      'SENDGRID_TEMPLATE_TICKET_CONFIRMATION',
      'SENDGRID_TEMPLATE_ORDER_EXPIRED',
      'SENDGRID_TEMPLATE_REFUND_ISSUED',
    ] as const) {
      if (!env[name])
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required when EMAIL_PROVIDER=sendgrid',
        });
    }
  });

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(): WorkerEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`Invalid environment variables:\n${problems.join('\n')}\nSee .env.example.`);
    process.exit(1);
  }
  return parsed.data;
}
