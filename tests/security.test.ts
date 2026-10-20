import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  encrypt,
  decrypt,
  verifyDeviceSignature,
  validatePublicKey,
} from '../src/shared/security/crypto.js';
import { similarity, facePolicy } from '../src/modules/face/face.policy.js';
import { readConfig } from '../src/config/env.js';
describe('biometric and device security', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  it('encrypts templates with authenticated user binding', () => {
    const encrypted = encrypt([1, 2, 3], key, 'user-a');
    expect(decrypt(encrypted, key, 'user-a')).toEqual([1, 2, 3]);
    expect(() => decrypt(encrypted, key, 'user-b')).toThrow();
    expect(() => decrypt(encrypted, Buffer.alloc(32, 2).toString('base64'), 'user-a')).toThrow();
  });
  it('rejects tampered encrypted templates', () => {
    const value = Buffer.from(encrypt([1, 0], key, 'user'), 'base64');
    value[value.length - 1] = value[value.length - 1]! ^ 1;
    expect(() => decrypt(value.toString('base64'), key, 'user')).toThrow();
  });
  it('binds the device signature to the full payload', () => {
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signature = sign(null, Buffer.from('original'), pair.privateKey).toString('base64');
    expect(validatePublicKey(pem)).toBe(true);
    expect(() => verifyDeviceSignature(pem, signature, 'original')).not.toThrow();
    expect(() => verifyDeviceSignature(pem, signature, 'changed')).toThrow();
  });
  it('rejects invalid and zero embeddings', () => {
    expect(similarity([1, 0], [1, 0])).toBe(1);
    expect(similarity([1, 0], [0, 1])).toBe(0);
    expect(() => similarity([0, 0], [1, 0])).toThrow();
    expect(() => similarity([1, 0], [1, 0, 0])).toThrow();
  });
  it('does not enable biometric acceptance with missing thresholds', () => {
    const config = readConfig({
      DATABASE_URL: 'postgresql://test:test@localhost/db',
      REDIS_URL: 'redis://localhost',
      JWT_SECRET: 's'.repeat(40),
      BIOMETRIC_KEY_BASE64: key,
    });
    expect(() => facePolicy(config)).toThrow('belum dikonfigurasi');
  });
});
