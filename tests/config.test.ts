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

  it('explains how to inject a missing biometric key into the container', () => {
    expect(() => readConfig({ ...env, BIOMETRIC_KEY_BASE64: undefined })).toThrow(
      'BIOMETRIC_KEY_BASE64 must be supplied to the running container',
    );
  });

  it('rejects empty keys and keys with the wrong decoded length', () => {
    for (const key of ['', Buffer.alloc(31).toString('base64')]) {
      expect(() => readConfig({ ...env, BIOMETRIC_KEY_BASE64: key })).toThrow(
        'Must decode to 32 bytes',
      );
    }
  });
});
