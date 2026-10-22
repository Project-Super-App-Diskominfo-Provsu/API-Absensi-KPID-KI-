import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { audit } from '../../database/audit.js';
import { transaction } from '../../database/client.js';
import { hash, token } from '../../shared/security/crypto.js';
import { fail } from '../../shared/errors/api-error.js';
import { issueSession } from '../auth/auth.service.js';
import type { User } from '../auth/auth.model.js';
import {
  insertSsoLoginFlow,
  consumeSsoLoginFlow,
  findSsoIdentityByIssuerSubject,
  findActiveSsoUserById,
  findSsoIdentityMapping,
  findUserForSsoUpdate,
  insertSsoIdentity,
  updateUserAuthMode,
  findSsoIdentitiesByUserId,
  findSsoIdentityById,
  deleteSsoIdentity,
  findSsoEmailCandidateForUpdate,
  insertSsoIdentityIfUnlinked,
  consumeGoogleEmailLinkingPermission,
  type SsoFlow,
} from './sso.model.js';

export type { SsoFlow };

export interface SsoProvider {
  authorizationUrl(flow: SsoFlow): Promise<string>;
  verify(
    flow: SsoFlow,
    code: string,
    verifier: string,
  ): Promise<{ issuer: string; subject: string }>;
}

export class OidcProvider implements SsoProvider {
  private discovery?: Promise<oidc.Configuration>;
  constructor(
    private config: Config,
    private fetcher?: oidc.CustomFetch,
  ) {}

  private async client() {
    if (!this.discovery) {
      const auth =
        this.config.SSO_TOKEN_AUTH_METHOD === 'none'
          ? oidc.None()
          : this.config.SSO_TOKEN_AUTH_METHOD === 'client_secret_post'
            ? oidc.ClientSecretPost(this.config.SSO_CLIENT_SECRET)
            : oidc.ClientSecretBasic(this.config.SSO_CLIENT_SECRET);
      this.discovery = oidc
        .discovery(new URL(this.config.SSO_ISSUER), this.config.SSO_CLIENT_ID, undefined, auth, {
          timeout: 8,
          ...(this.fetcher ? { [oidc.customFetch]: this.fetcher } : {}),
        })
        .then((client) => {
          oidc.enableNonRepudiationChecks(client);
          return client;
        })
        .catch((error) => {
          this.discovery = undefined;
          throw error;
        });
    }
    return this.discovery;
  }

  async authorizationUrl(flow: SsoFlow) {
    return oidc.buildAuthorizationUrl(await this.client(), {
      redirect_uri: this.config.SSO_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge: flow.code_challenge,
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    }).href;
  }

  async verify(flow: SsoFlow, code: string, verifier: string) {
    const url = new URL(this.config.SSO_REDIRECT_URI);
    url.searchParams.set('code', code);
    url.searchParams.set('state', flow.state);
    const tokens = await oidc.authorizationCodeGrant(await this.client(), url, {
      pkceCodeVerifier: verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || claims.iss !== this.config.SSO_ISSUER || !claims.sub) {
      throw new Error('Invalid OIDC identity');
    }
    return { issuer: claims.iss, subject: claims.sub };
  }
}

export function requireSso(config: Config) {
  if (config.SSO_ENABLED !== 'true') {
    fail(503, 'SSO_NOT_CONFIGURED', 'SSO instansi belum dikonfigurasi.');
  }
}

export function getAuthMethods(config: Config) {
  return {
    local: true,
    sso: config.SSO_ENABLED === 'true',
    sso_protocol: config.SSO_ENABLED === 'true' ? ('oidc' as const) : null,
    google: config.GOOGLE_ENABLED === 'true',
    web: config.WEB_AUTH_ENABLED === 'true',
  };
}

export async function startSsoLoginFlow(
  pool: Pool,
  config: Config,
  provider: SsoProvider,
  codeChallenge: string,
) {
  requireSso(config);
  const flow = { state: token(), nonce: token(), code_challenge: codeChallenge };
  let url: string;
  try {
    url = await provider.authorizationUrl(flow);
  } catch {
    return fail(503, 'SSO_UNAVAILABLE', 'Penyedia SSO belum dapat dihubungi.');
  }
  const row = await insertSsoLoginFlow(
    pool,
    config.SSO_ISSUER,
    hash(flow.state),
    flow.nonce,
    flow.code_challenge,
  );
  return {
    flow_id: row.rows[0]!.id,
    authorization_url: url,
    expires_at: row.rows[0]!.expires_at,
  };
}

export async function exchangeSsoCode(
  pool: Pool,
  config: Config,
  provider: SsoProvider,
  input: {
    flow_id: string;
    state: string;
    code: string;
    code_verifier: string;
  },
) {
  requireSso(config);
  const challenge = await oidc.calculatePKCECodeChallenge(input.code_verifier);
  const consumed = await consumeSsoLoginFlow(
    pool,
    input.flow_id,
    config.SSO_ISSUER,
    hash(input.state),
    challenge,
  );
  if (!consumed.rowCount) {
    fail(401, 'SSO_FLOW_INVALID', 'Sesi SSO tidak valid, kedaluwarsa, atau sudah digunakan.');
  }

  let identity: { issuer: string; subject: string };
  try {
    identity = await provider.verify(
      { state: input.state, nonce: consumed.rows[0]!.nonce, code_challenge: challenge },
      input.code,
      input.code_verifier,
    );
  } catch {
    return fail(401, 'SSO_LOGIN_FAILED', 'Validasi login SSO gagal. Mulai login ulang.');
  }

  if (identity.issuer !== config.SSO_ISSUER) {
    fail(401, 'SSO_LOGIN_FAILED', 'Issuer SSO tidak sesuai.');
  }

  return sessionForSsoIdentity(pool, config, identity);
}

export async function sessionForSsoIdentity(
  pool: Pool,
  config: Config,
  identity: { issuer: string; subject: string },
  clientType: 'MOBILE' | 'WEB' = 'MOBILE',
  options: { firstLoginEmail?: string } = {},
) {
  return transaction(pool, async (db) => {
    let mapping = await findSsoIdentityByIssuerSubject(db, identity.issuer, identity.subject);
    if (!mapping.rowCount && options.firstLoginEmail && clientType === 'MOBILE') {
      const candidate = (await findSsoEmailCandidateForUpdate(db, options.firstLoginEmail)).rows[0];
      if (
        !candidate ||
        !candidate.active ||
        !['SSO', 'BOTH'].includes(candidate.auth_mode) ||
        !['EMPLOYEE', 'VERIFIER'].includes(candidate.role) ||
        !['KPID', 'KI'].includes(candidate.employee_category_code ?? '')
      )
        fail(
          403,
          'SSO_ACCOUNT_NOT_LINKED',
          'Akun SSO belum dipetakan atau login SSO belum diizinkan.',
        );
      // Another first login may have completed while waiting for the user lock.
      mapping = await findSsoIdentityByIssuerSubject(db, identity.issuer, identity.subject);
      if (
        (!mapping.rowCount || mapping.rows[0]!.user_id !== candidate.id) &&
        !candidate.google_email_linking_allowed
      )
        fail(403, 'SSO_ACCOUNT_NOT_LINKED', 'Penautan pertama Google belum diizinkan oleh admin.');
      const inserted = await insertSsoIdentityIfUnlinked(
        db,
        candidate.id,
        identity.issuer,
        identity.subject,
      );
      mapping = await findSsoIdentityByIssuerSubject(db, identity.issuer, identity.subject);
      if (!mapping.rowCount || mapping.rows[0]!.user_id !== candidate.id)
        fail(
          403,
          'SSO_IDENTITY_CONFLICT',
          'Identitas Google sudah memiliki pemetaan berbeda. Hubungi admin.',
        );
      if (inserted.rowCount) {
        await consumeGoogleEmailLinkingPermission(db, candidate.id);
        await audit(db, candidate.id, 'GOOGLE_IDENTITY_AUTO_LINKED', inserted.rows[0]!.id, {
          user_id: candidate.id,
          method: 'VERIFIED_GOOGLE_EMAIL',
        });
      }
    }
    if (!mapping.rowCount) {
      fail(403, 'SSO_ACCOUNT_NOT_LINKED', 'Akun SSO belum dipetakan ke pegawai oleh admin.');
    }
    const userId = mapping.rows[0]!.user_id;
    const active = await findActiveSsoUserById(db, userId);
    if (!active.rowCount) {
      fail(403, 'SSO_ACCOUNT_DISABLED', 'Login SSO akun ini tidak diizinkan.');
    }
    const current = await findSsoIdentityMapping(db, identity.issuer, identity.subject, userId);
    if (!current.rowCount) fail(403, 'SSO_ACCOUNT_NOT_LINKED', 'Pemetaan akun SSO berubah.');

    if (clientType === 'WEB' && !['ADMIN', 'SUPER_ADMIN'].includes(active.rows[0]!.role))
      fail(403, 'ADMIN_ACCESS_REQUIRED', 'Panel hanya untuk administrator.');
    const session = await issueSession(db, config, userId, randomUUID(), undefined, clientType);
    await audit(db, userId, 'SSO_LOGIN', current.rows[0]!.id);
    return session;
  });
}

export async function linkSsoIdentity(
  pool: Pool,
  config: Config,
  actor: User,
  input: {
    user_id: string;
    subject: string;
    auth_mode: 'SSO' | 'BOTH';
    reason: string;
    issuer?: string;
  },
) {
  const issuers = [
    config.SSO_ENABLED === 'true' ? config.SSO_ISSUER : '',
    config.GOOGLE_ENABLED === 'true' ? 'https://accounts.google.com' : '',
  ].filter(Boolean);
  if (!issuers.length) fail(503, 'SSO_NOT_CONFIGURED', 'Penyedia SSO belum dikonfigurasi.');
  const issuer = input.issuer ?? issuers[0]!;
  if (!issuers.includes(issuer)) fail(400, 'SSO_ISSUER_INVALID', 'Issuer tidak dikonfigurasi.');
  if (actor.id === input.user_id) {
    fail(403, 'SELF_UPDATE_FORBIDDEN', 'Pemetaan akun sendiri memerlukan admin lain.');
  }

  return transaction(pool, async (db) => {
    const user = await findUserForSsoUpdate(db, input.user_id);
    if (!user.rowCount) fail(404, 'NOT_FOUND', 'Pegawai tidak ditemukan.');

    const mapped = await insertSsoIdentity(db, input.user_id, issuer, input.subject);
    if (issuer === 'https://accounts.google.com')
      await consumeGoogleEmailLinkingPermission(db, input.user_id);
    await updateUserAuthMode(db, input.user_id, input.auth_mode);
    await db.query(
      'UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',
      [input.user_id],
    );
    await audit(db, actor.id, 'SSO_IDENTITY_LINKED', mapped.rows[0]!.id, {
      user_id: input.user_id,
      auth_mode: input.auth_mode,
      reason: input.reason,
    });
    return mapped.rows[0]!;
  });
}

export async function listSsoIdentities(pool: Pool, userId: string) {
  const result = await findSsoIdentitiesByUserId(pool, userId);
  return result.rows;
}

export async function unlinkSsoIdentity(pool: Pool, actor: User, id: string, reason: string) {
  return transaction(pool, async (db) => {
    const identity = await findSsoIdentityById(db, id);
    if (!identity.rowCount) fail(404, 'NOT_FOUND', 'Pemetaan tidak ditemukan.');
    const owner = identity.rows[0]!.user_id;
    if (owner === actor.id) {
      fail(403, 'SELF_UPDATE_FORBIDDEN', 'Pemetaan akun sendiri memerlukan admin lain.');
    }
    await findUserForSsoUpdate(db, owner);
    await deleteSsoIdentity(db, id);
    if (identity.rows[0]!.issuer === 'https://accounts.google.com')
      await consumeGoogleEmailLinkingPermission(db, owner);
    await db.query(
      'UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',
      [owner],
    );
    await audit(db, actor.id, 'SSO_IDENTITY_UNLINKED', id, { user_id: owner, reason });
  });
}
