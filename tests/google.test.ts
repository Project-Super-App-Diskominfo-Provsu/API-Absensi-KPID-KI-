import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GoogleOidcProvider } from '../src/modules/sso/google.service.js';
import { readConfig } from '../src/config/env.js';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 's'.repeat(40),
  GOOGLE_ENABLED: 'true',
  GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
  GOOGLE_ANDROID_CLIENT_IDS: 'android.apps.googleusercontent.com',
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>, provider: GoogleOidcProvider;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  provider = new GoogleOidcProvider(
    readConfig(env),
    createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256' }],
    }),
  );
});
async function idToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'google-subject',
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_WEB_CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: 'server-nonce',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .sign(keys.privateKey);
}
describe('Google ID token verification', () => {
  it('verifies the signature and returns only the canonical issuer and subject', async () => {
    expect(
      await provider.verifyIdToken(
        await idToken({ iss: 'accounts.google.com', azp: 'android.apps.googleusercontent.com' }),
        'server-nonce',
      ),
    ).toEqual({ issuer: 'https://accounts.google.com', subject: 'google-subject' });
  });
  it.each([
    { aud: 'another.apps.googleusercontent.com' },
    { iss: 'https://attacker.example' },
    { nonce: 'other-nonce' },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
    { sub: '' },
    { azp: 'unregistered.apps.googleusercontent.com' },
    { aud: [env.GOOGLE_WEB_CLIENT_ID, 'other-client'] },
  ])('rejects invalid claims: %j', async (claims) => {
    await expect(provider.verifyIdToken(await idToken(claims), 'server-nonce')).rejects.toThrow();
  });
  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ nonce: 'server-nonce' })
      .setSubject('google-subject')
      .setIssuer('https://accounts.google.com')
      .setAudience(env.GOOGLE_WEB_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .sign(other.privateKey);
    await expect(provider.verifyIdToken(token, 'server-nonce')).rejects.toThrow();
  });
});
describe('web and Google configuration', () => {
  it('supports native Google without a callback or client secret', () => {
    expect(readConfig(env).GOOGLE_ENABLED).toBe('true');
  });
  it('requires an explicit production HTTPS origin for web login', () => {
    for (const origin of [
      '',
      '*',
      'https://admin.example/path',
      'http://admin.example',
      'http://localhost:3001',
    ])
      expect(() =>
        readConfig({
          ...env,
          NODE_ENV: 'production',
          WEB_AUTH_ENABLED: 'true',
          ADMIN_WEB_ORIGIN: origin,
        }),
      ).toThrow('ADMIN_WEB_ORIGIN');
  });
  it('requires a backend callback and secret only for Google web login', () => {
    expect(() =>
      readConfig({ ...env, WEB_AUTH_ENABLED: 'true', ADMIN_WEB_ORIGIN: 'https://admin.example' }),
    ).toThrow('GOOGLE_REDIRECT_URI');
    expect(
      readConfig({
        ...env,
        WEB_AUTH_ENABLED: 'true',
        ADMIN_WEB_ORIGIN: 'https://admin.example',
        GOOGLE_CLIENT_SECRET: 'fixture',
        GOOGLE_REDIRECT_URI: 'https://api.example/api/v1/auth/web/google/callback',
      }).GOOGLE_ENABLED,
    ).toBe('true');
  });
});
