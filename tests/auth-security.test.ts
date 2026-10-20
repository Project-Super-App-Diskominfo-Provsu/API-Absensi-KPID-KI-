import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { verifyUserToken } from '../src/modules/auth/auth.service.js';
import { hashPassword, verifyPassword } from '../src/shared/security/password.js';
const secret = 'auth-security-test-secret-'.repeat(3);
async function signed(
  options: {
    expiry?: boolean;
    issued?: boolean;
    issuer?: string;
    audience?: string;
    algorithm?: string;
    expired?: boolean;
  } = {},
) {
  let jwt = new SignJWT({ sid: randomUUID() })
    .setSubject(randomUUID())
    .setJti(randomUUID())
    .setProtectedHeader({ alg: options.algorithm ?? 'HS256', typ: 'JWT' })
    .setIssuer(options.issuer ?? 'absensi-api')
    .setAudience(options.audience ?? 'absensi-mobile');
  if (options.issued !== false) jwt = jwt.setIssuedAt();
  if (options.expiry !== false)
    jwt = jwt.setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 60 : '10m');
  return jwt.sign(new TextEncoder().encode(secret));
}
describe('access token verification', () => {
  it('rejects a token signed with a different secret', async () => {
    await expect(
      verifyUserToken('different-secret-that-is-long-enough', `Bearer ${await signed()}`),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
  it('accepts an intact token with the required claims', async () => {
    await expect(verifyUserToken(secret, `Bearer ${await signed()}`)).resolves.toHaveProperty(
      'sessionId',
    );
  });
  for (const [label, options] of [
    ['missing expiration', { expiry: false }],
    ['missing issue time', { issued: false }],
    ['wrong issuer', { issuer: 'another-api' }],
    ['wrong audience', { audience: 'another-app' }],
    ['unexpected algorithm', { algorithm: 'HS384' }],
    ['expired token', { expired: true }],
  ] as const)
    it(`rejects ${label}`, async () => {
      await expect(
        verifyUserToken(secret, `Bearer ${await signed(options)}`),
      ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });
});
it('bounds expensive password operations and recovers after the active operations finish', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => hashPassword('long-test-password-value')),
  );
  expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(4);
  const rejected = results.find((v) => v.status === 'rejected');
  expect(rejected?.reason).toMatchObject({ code: 'AUTH_BUSY' });
  const encoded = (results.find((v) => v.status === 'fulfilled') as PromiseFulfilledResult<string>)
    .value;
  expect(await verifyPassword(encoded, 'long-test-password-value')).toBe(true);
  expect(await verifyPassword('broken-hash', 'long-test-password-value')).toBe(false);
});
