import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { calculatePKCECodeChallenge } from 'openid-client';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { fail } from '../../shared/errors/api-error.js';
import { hash, token } from '../../shared/security/crypto.js';
import { OidcProvider, sessionForSsoIdentity, type SsoFlow } from './sso.service.js';
import { insertGoogleFlow, consumeGoogleMobileFlow, consumeGoogleWebFlow } from './google.model.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export interface GoogleProvider {
  authorizationUrl(flow: SsoFlow): Promise<string>;
  verifyCode(
    flow: SsoFlow,
    code: string,
    verifier: string,
  ): Promise<{ issuer: string; subject: string }>;
  verifyIdToken(idToken: string, nonce: string): Promise<{ issuer: string; subject: string }>;
}

export class GoogleOidcProvider implements GoogleProvider {
  private oidc: OidcProvider;
  constructor(
    private config: Config,
    private keys: JWTVerifyGetKey = createRemoteJWKSet(
      new URL('https://www.googleapis.com/oauth2/v3/certs'),
      { timeoutDuration: 5000 },
    ),
  ) {
    this.oidc = new OidcProvider({
      ...config,
      SSO_ISSUER: GOOGLE_ISSUER,
      SSO_CLIENT_ID: config.GOOGLE_WEB_CLIENT_ID,
      SSO_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET,
      SSO_REDIRECT_URI: config.GOOGLE_REDIRECT_URI,
      SSO_TOKEN_AUTH_METHOD: 'client_secret_post',
    });
  }
  authorizationUrl(flow: SsoFlow) {
    return this.oidc.authorizationUrl(flow);
  }
  verifyCode(flow: SsoFlow, code: string, verifier: string) {
    return this.oidc.verify(flow, code, verifier);
  }
  async verifyIdToken(idToken: string, nonce: string) {
    const { payload } = await jwtVerify(idToken, this.keys, {
      algorithms: ['RS256'],
      issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
      audience: this.config.GOOGLE_WEB_CLIENT_ID,
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'],
      maxTokenAge: '1h',
    });
    const presenters = [
      this.config.GOOGLE_WEB_CLIENT_ID,
      ...this.config.GOOGLE_ANDROID_CLIENT_IDS.split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ];
    if (
      payload.nonce !== nonce ||
      !payload.sub ||
      payload.sub.length > 255 ||
      (payload.azp !== undefined && !presenters.includes(String(payload.azp))) ||
      (Array.isArray(payload.aud) && payload.azp === undefined)
    )
      throw new Error('Invalid Google identity');
    return { issuer: GOOGLE_ISSUER, subject: payload.sub };
  }
}

export function requireGoogle(config: Config) {
  if (config.GOOGLE_ENABLED !== 'true')
    fail(503, 'GOOGLE_NOT_CONFIGURED', 'Login Google belum dikonfigurasi.');
}

export async function googleChallenge(pool: Pool, config: Config) {
  requireGoogle(config);
  const nonce = token();
  const result = await insertGoogleFlow(pool, nonce, 'MOBILE');
  return { challenge_id: result.rows[0]!.id, nonce, expires_at: result.rows[0]!.expires_at };
}

export async function googleMobileLogin(
  pool: Pool,
  config: Config,
  provider: GoogleProvider,
  id: string,
  idToken: string,
) {
  requireGoogle(config);
  const result = await consumeGoogleMobileFlow(pool, id);
  if (!result.rowCount)
    fail(401, 'SSO_FLOW_INVALID', 'Challenge Google tidak valid atau telah digunakan.');
  let identity;
  try {
    identity = await provider.verifyIdToken(idToken, result.rows[0]!.nonce);
  } catch {
    return fail(401, 'SSO_LOGIN_FAILED', 'Validasi login Google gagal. Mulai login ulang.');
  }
  if (identity.issuer !== GOOGLE_ISSUER)
    fail(401, 'SSO_LOGIN_FAILED', 'Issuer Google tidak sesuai.');
  return sessionForSsoIdentity(pool, config, identity);
}

export async function startGoogleWeb(pool: Pool, config: Config, provider: GoogleProvider) {
  requireGoogle(config);
  const state = token(),
    nonce = token(),
    verifier = token(),
    browser = token();
  const flow = { state, nonce, code_challenge: await calculatePKCECodeChallenge(verifier) };
  let url;
  try {
    url = await provider.authorizationUrl(flow);
  } catch {
    return fail(503, 'SSO_UNAVAILABLE', 'Google belum dapat dihubungi.');
  }
  await insertGoogleFlow(pool, nonce, 'WEB', hash(state), hash(browser), verifier);
  return { authorization_url: url, browser };
}

export async function completeGoogleWeb(
  pool: Pool,
  config: Config,
  provider: GoogleProvider,
  state: string,
  browser: string,
  code: string,
) {
  requireGoogle(config);
  const result = await consumeGoogleWebFlow(pool, hash(state), hash(browser));
  if (!result.rowCount)
    fail(401, 'SSO_FLOW_INVALID', 'Sesi Google tidak valid atau telah digunakan.');
  const row = result.rows[0]!;
  let identity;
  try {
    identity = await provider.verifyCode(
      {
        state,
        nonce: row.nonce,
        code_challenge: await calculatePKCECodeChallenge(row.code_verifier!),
      },
      code,
      row.code_verifier!,
    );
  } catch {
    return fail(401, 'SSO_LOGIN_FAILED', 'Validasi login Google gagal. Mulai login ulang.');
  }
  if (identity.issuer !== GOOGLE_ISSUER)
    fail(401, 'SSO_LOGIN_FAILED', 'Issuer Google tidak sesuai.');
  return sessionForSsoIdentity(pool, config, identity, 'WEB');
}
