import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://festpass:festpass@localhost:5433/festpass',
  REDIS_URL: 'redis://localhost:6380',
  MONGODB_URI: 'mongodb://localhost:27018/festpass',
};

describe('parseEnv', () => {
  it('applies defaults and coerces numbers', () => {
    const env = parseEnv({ ...valid, API_PORT: '4100' });

    expect(env).toMatchObject({
      API_PORT: 4100,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('lists every missing or invalid variable in one message', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined, API_PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*API_PORT|API_PORT[\s\S]*DATABASE_URL/,
    );
  });
});
