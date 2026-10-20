import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  verify,
} from 'node:crypto';
import { fail } from '../errors/api-error.js';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function encrypt(value: number[], key: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(userId));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decrypt(value: string, key: string, userId: string): number[] {
  const b = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), b.subarray(0, 12));
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'),
  ) as number[];
}
export function validatePublicKey(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
export function verifyDeviceSignature(publicKey: string, signature: string, payload: string) {
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    /* Invalid key or signature. */
  }
  if (!valid) fail(403, 'DEVICE_SIGNATURE_INVALID', 'Tanda tangan perangkat tidak valid.');
}
