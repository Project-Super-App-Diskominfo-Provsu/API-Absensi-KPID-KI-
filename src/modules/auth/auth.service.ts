import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { transaction, type Db } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import { hash, token } from '../../shared/security/crypto.js';
import { hashPassword, verifyPassword } from '../../shared/security/password.js';
import { audit } from '../../database/audit.js';
import {
  findUserByEmail,
  findActiveUserForShare,
  findUserByIdForUpdate,
  findSessionByTokenHash,
  findSessionWithUserForUpdate,
  revokeSessionFamily,
  revokeSessionById,
  findSessionById,
  revokeAllUserSessions,
  findPasswordForUpdate,
  updatePassword,
  findUserWithValidSession,
  insertRefreshSession,
  type User,
} from './auth.model.js';

let dummyHash: Promise<string> | undefined;

export async function issueSession(
  db: Db,
  config: Config,
  userId: string,
  family: string,
  expiresAt?: Date,
) {
  const refreshToken = token();
  const row = await insertRefreshSession(db, userId, family, hash(refreshToken), expiresAt);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expires = Math.min(issuedAt + 600, Math.floor(row.rows[0]!.expires_at.getTime() / 1000));
  if (expires <= issuedAt)
    fail(401, 'REFRESH_INVALID', 'Sesi sudah kedaluwarsa. Silakan login ulang.');
  const access = await new SignJWT({ sid: row.rows[0]!.id })
    .setSubject(userId)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuer('absensi-api')
    .setAudience('absensi-mobile')
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return {
    access_token: access,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: expires - issuedAt,
  };
}

export async function loginUser(pool: Pool, config: Config, email: string, passwordPlain: string) {
  const found = await findUserByEmail(pool, email);
  const fallback = await (dummyHash ??= hashPassword(token()).catch((error: unknown) => {
    dummyHash = undefined;
    throw error;
  }));
  const user = found.rows[0];
  const valid = await verifyPassword(user?.password_hash ?? fallback, passwordPlain);

  if (!user?.active || !valid || user.auth_mode === 'SSO') {
    fail(401, 'LOGIN_FAILED', 'Email atau password tidak valid.');
  }

  const result = await transaction(pool, async (db) => {
    const active = await findActiveUserForShare(db, user!.id, user!.password_hash);
    if (!active.rowCount) fail(401, 'LOGIN_FAILED', 'Email atau password tidak valid.');
    const session = await issueSession(db, config, user!.id, randomUUID());
    await audit(db, user!.id, 'LOCAL_LOGIN', user!.id);
    return session;
  });

  return result;
}

export async function refreshUserSession(pool: Pool, config: Config, refreshToken: string) {
  const result = await transaction(pool, async (db) => {
    const tokenH = hash(refreshToken);
    const initial = await findSessionByTokenHash(db, tokenH);
    if (!initial.rowCount) return null;

    await findUserByIdForUpdate(db, initial.rows[0]!.user_id);
    const row = await findSessionWithUserForUpdate(db, tokenH);
    const session = row.rows[0];

    if (!session?.active || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      if (session) {
        await revokeSessionFamily(db, session.family_id);
      }
      return null;
    }

    await revokeSessionById(db, session.id);
    return issueSession(db, config, session.user_id, session.family_id, session.expires_at);
  });

  if (!result) fail(401, 'REFRESH_INVALID', 'Refresh token tidak valid atau sudah digunakan.');
  return result;
}

export async function logoutUser(pool: Pool, sessionId: string) {
  await transaction(pool, async (db) => {
    const session = await findSessionById(db, sessionId);
    if (!session.rowCount) return;
    const { user_id, family_id } = session.rows[0]!;
    await findUserByIdForUpdate(db, user_id);
    await revokeSessionFamily(db, family_id);
    await audit(db, user_id, 'LOGOUT', family_id);
  });
}
export async function logoutAllUserSessions(pool: Pool, userId: string) {
  await transaction(pool, async (db) => {
    await findUserByIdForUpdate(db, userId);
    await revokeAllUserSessions(db, userId);
    await audit(db, userId, 'LOGOUT_ALL', userId);
  });
}
export async function changePassword(pool: Pool, userId: string, current: string, next: string) {
  if (current === next) fail(400, 'PASSWORD_UNCHANGED', 'Password baru harus berbeda.');
  const encoded = await hashPassword(next);
  await transaction(pool, async (db) => {
    const result = await findPasswordForUpdate(db, userId),
      user = result.rows[0];
    if (
      !user?.active ||
      user.auth_mode === 'SSO' ||
      !(await verifyPassword(user.password_hash, current))
    )
      fail(
        401,
        'PASSWORD_CHANGE_FAILED',
        'Password saat ini tidak valid atau akun tidak diizinkan.',
      );
    await updatePassword(db, userId, encoded);
    await revokeAllUserSessions(db, userId);
    await audit(db, userId, 'PASSWORD_CHANGED', userId);
  });
}

export async function verifyUserToken(secretKey: string, bearerHeader?: string) {
  if (!bearerHeader?.startsWith('Bearer ')) fail(401, 'UNAUTHENTICATED', 'Silakan login.');
  const secret = new TextEncoder().encode(secretKey);
  try {
    const { payload } = await jwtVerify(bearerHeader.slice(7), secret, {
      algorithms: ['HS256'],
      issuer: 'absensi-api',
      audience: 'absensi-mobile',
      typ: 'JWT',
      requiredClaims: ['sub', 'sid', 'iss', 'aud', 'exp', 'iat', 'jti'],
      maxTokenAge: '10m',
    });
    const sub = z.uuid().parse(payload.sub);
    const sid = z.uuid().parse(payload.sid);
    return { userId: sub, sessionId: sid };
  } catch {
    return fail(401, 'TOKEN_INVALID', 'Token tidak valid atau kedaluwarsa.');
  }
}

export async function getUserWithActiveSession(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<User> {
  const result = await findUserWithValidSession(pool, userId, sessionId);
  if (!result.rowCount) fail(401, 'SESSION_REVOKED', 'Sesi sudah dicabut.');
  return result.rows[0]!;
}
