import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://festpass:festpass@localhost:5433/festpass',
  REDIS_URL: 'redis://localhost:6380',
  MONGODB_URI: 'mongodb://localhost:27018/festpass',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  REVALIDATE_SECRET: 'y'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'festpass',
  S3_ACCESS_KEY_ID: 'festpass',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_URL: 'http://localhost:9000/festpass/',
};

describe('parseEnv', () => {
  it('applies defaults and coerces numbers', () => {
    const env = parseEnv({ ...valid, API_PORT: '4100' });

    expect(env).toMatchObject({
      API_PORT: 4100,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 7,
      S3_REGION: 'us-east-1',
      S3_PUBLIC_URL: 'http://localhost:9000/festpass',
    });
  });

  it('lists every missing or invalid variable in one message', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined, API_PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*API_PORT|API_PORT[\s\S]*DATABASE_URL/,
    );
  });
});
