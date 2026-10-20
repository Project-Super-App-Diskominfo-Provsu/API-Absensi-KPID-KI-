import type { Db } from '../../database/client.js';

export interface User {
  id: string;
  employee_number: string;
  name: string;
  email: string;
  role: 'EMPLOYEE' | 'VERIFIER' | 'ADMIN' | 'SUPER_ADMIN';
  employee_category_code: 'KPID' | 'KI' | null;
  unit_id: string | null;
  auth_mode: 'LOCAL' | 'SSO' | 'BOTH';
  active?: boolean;
}

export interface RefreshSession {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
  active?: boolean;
}

export const userFields =
  'id,employee_number,name,email,role,employee_category_code,unit_id,active,auth_mode';

export async function findUserByEmail(db: Db, email: string) {
  return db.query<{
    id: string;
    password_hash: string;
    active: boolean;
    auth_mode: 'LOCAL' | 'SSO' | 'BOTH';
  }>('SELECT id,password_hash,active,auth_mode FROM users WHERE email=$1', [email]);
}

export async function findActiveUserForShare(db: Db, userId: string) {
  return db.query<{ id: string }>(
    "SELECT id FROM users WHERE id=$1 AND active AND auth_mode IN ('LOCAL','BOTH') FOR SHARE",
    [userId],
  );
}

export async function findUserByIdForUpdate(db: Db, userId: string) {
  return db.query<{ id: string }>('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
}

export async function findSessionByTokenHash(db: Db, tokenHash: string) {
  return db.query<{ user_id: string }>('SELECT user_id FROM refresh_sessions WHERE token_hash=$1', [
    tokenHash,
  ]);
}

export async function findSessionWithUserForUpdate(db: Db, tokenHash: string) {
  return db.query<RefreshSession>(
    `SELECT s.*,u.active FROM refresh_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 FOR UPDATE OF s`,
    [tokenHash],
  );
}

export async function revokeSessionFamily(db: Db, familyId: string) {
  return db.query(
    'UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1',
    [familyId],
  );
}

export async function revokeSessionById(db: Db, sessionId: string) {
  return db.query('UPDATE refresh_sessions SET revoked_at=now() WHERE id=$1', [sessionId]);
}

export async function revokeSessionBySessionIdFamily(db: Db, sessionId: string) {
  return db.query(
    `UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now())
    WHERE family_id=(SELECT family_id FROM refresh_sessions WHERE id=$1)`,
    [sessionId],
  );
}

export async function findUserWithValidSession(db: Db, userId: string, sessionId: string) {
  return db.query<User>(
    `SELECT ${userFields} FROM users WHERE id=$1 AND active=true
    AND EXISTS(SELECT 1 FROM refresh_sessions WHERE id=$2 AND user_id=$1 AND revoked_at IS NULL AND expires_at>now())`,
    [userId, sessionId],
  );
}

export async function insertRefreshSession(
  db: Db,
  userId: string,
  familyId: string,
  tokenHash: string,
) {
  return db.query<{ id: string }>(
    `INSERT INTO refresh_sessions(user_id,family_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '30 days') RETURNING id`,
    [userId, familyId, tokenHash],
  );
}
