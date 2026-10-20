import { SignJWT, jwtVerify } from 'jose';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { transaction, type Db } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import { hash, token } from '../../shared/security/crypto.js';
import {
  findUserByEmail,
  findActiveUserForShare,
  findUserByIdForUpdate,
  findSessionByTokenHash,
  findSessionWithUserForUpdate,
  revokeSessionFamily,
  revokeSessionById,
  revokeSessionBySessionIdFamily,
  findUserWithValidSession,
  insertRefreshSession,
  type User,
} from './auth.model.js';

let dummyHash: string | undefined;

export async function issueSession(db: Db, config: Config, userId: string, family: string) {
  const refreshToken = token();
  const row = await insertRefreshSession(db, userId, family, hash(refreshToken));
  const access = await new SignJWT({ sid: row.rows[0]!.id })
    .setSubject(userId)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('absensi-api')
    .setAudience('absensi-mobile')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return {
    access_token: access,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 600,
  };
}

export async function loginUser(pool: Pool, config: Config, email: string, passwordPlain: string) {
  const found = await findUserByEmail(pool, email);
  dummyHash ??= await argon2.hash(token());
  const user = found.rows[0];
  const valid = await argon2.verify(user?.password_hash ?? dummyHash, passwordPlain);

  if (!user?.active || !valid || user.auth_mode === 'SSO') {
    fail(401, 'LOGIN_FAILED', 'Email atau password tidak valid.');
  }

  const result = await transaction(pool, async (db) => {
    const active = await findActiveUserForShare(db, user!.id);
    if (!active.rowCount) fail(401, 'LOGIN_FAILED', 'Email atau password tidak valid.');
    return issueSession(db, config, user!.id, randomUUID());
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
    return issueSession(db, config, session.user_id, session.family_id);
  });

  if (!result) fail(401, 'REFRESH_INVALID', 'Refresh token tidak valid atau sudah digunakan.');
  return result;
}

export async function logoutUser(pool: Pool, sessionId: string) {
  await revokeSessionBySessionIdFamily(pool, sessionId);
}

export async function verifyUserToken(secretKey: string, bearerHeader?: string) {
  if (!bearerHeader?.startsWith('Bearer ')) fail(401, 'UNAUTHENTICATED', 'Silakan login.');
  const secret = new TextEncoder().encode(secretKey);
  try {
    const { payload } = await jwtVerify(bearerHeader.slice(7), secret, {
      algorithms: ['HS256'],
      issuer: 'absensi-api',
      audience: 'absensi-mobile',
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
