import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config/env.js';

describe('runtime environment', () => {
  const env = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@database:5432/test',
    REDIS_URL: 'redis://redis:6379',
    JWT_SECRET: 's'.repeat(40),
    BIOMETRIC_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  };

  it('accepts runtime secrets without biometric calibration', () => {
    expect(readConfig(env).BIOMETRIC_KEY_BASE64).toBe(env.BIOMETRIC_KEY_BASE64);
  });

  it('keeps source startup migrations opt-in', () => {
    expect(readConfig(env).DB_MIGRATE_ON_START).toBe('false');
    expect(readConfig({ ...env, DB_MIGRATE_ON_START: 'true' }).DB_MIGRATE_ON_START).toBe('true');
    expect(() => readConfig({ ...env, DB_MIGRATE_ON_START: 'yes' })).toThrow();
  });

  it.each([undefined, ''])('allows auth startup with biometric key %s', (key) => {
    expect(readConfig({ ...env, BIOMETRIC_KEY_BASE64: key }).BIOMETRIC_KEY_BASE64).toBe('');
  });

  it('rejects nonempty keys with the wrong decoded length', () => {
    for (const key of ['not-base64', Buffer.alloc(31).toString('base64')]) {
      expect(() => readConfig({ ...env, BIOMETRIC_KEY_BASE64: key })).toThrow(
        'Must decode to 32 bytes',
      );
    }
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'])(
    'still requires %s for auth startup',
    (name) => {
      expect(() =>
        readConfig({ ...env, [name]: undefined, BIOMETRIC_KEY_BASE64: undefined }),
      ).toThrow();
    },
  );
});
