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
import { HttpFaceEngine } from '../src/modules/face/face.client.js';
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
  it('blocks biometrics without a key even when worker and thresholds are configured', async () => {
    const config = readConfig({
      DATABASE_URL: 'postgresql://test:test@localhost/db',
      REDIS_URL: 'redis://localhost',
      JWT_SECRET: 's'.repeat(40),
      FACE_WORKER_TOKEN: 'w'.repeat(40),
      FACE_MODEL_VERSION: 'fixture-model',
      FACE_MATCH_THRESHOLD: '0.8',
      FACE_REVIEW_THRESHOLD: '0.6',
      FACE_LIVENESS_THRESHOLD: '0.9',
      FACE_QUALITY_THRESHOLD: '0.7',
    });
    expect(() => facePolicy(config)).toThrow(
      expect.objectContaining({ status: 503, code: 'FACE_NOT_CONFIGURED' }),
    );
    const engine = new HttpFaceEngine(config);
    expect(await engine.ready()).toBe(false);
    await expect(engine.observe(Buffer.from('fixture'), 'nonce')).rejects.toMatchObject({
      status: 503,
      code: 'FACE_NOT_CONFIGURED',
    });
  });
});
