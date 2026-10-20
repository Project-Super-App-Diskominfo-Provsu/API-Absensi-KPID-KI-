import type { Db } from '../../database/client.js';

export interface SsoFlow {
  state: string;
  nonce: string;
  code_challenge: string;
}

export interface SsoIdentity {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  created_at: string;
}

export async function insertSsoLoginFlow(
  db: Db,
  issuer: string,
  stateHash: string,
  nonce: string,
  codeChallenge: string,
) {
  return db.query<{ id: string; expires_at: string }>(
    `INSERT INTO sso_login_flows(issuer,state_hash,nonce,code_challenge) VALUES($1,$2,$3,$4) RETURNING id,expires_at`,
    [issuer, stateHash, nonce, codeChallenge],
  );
}

export async function consumeSsoLoginFlow(
  db: Db,
  flowId: string,
  issuer: string,
  stateHash: string,
  challenge: string,
) {
  return db.query<{ nonce: string; code_challenge: string }>(
    `UPDATE sso_login_flows SET consumed_at=now() WHERE id=$1 AND issuer=$2 AND state_hash=$3 AND code_challenge=$4
    AND consumed_at IS NULL AND expires_at>now() RETURNING nonce,code_challenge`,
    [flowId, issuer, stateHash, challenge],
  );
}

export async function findSsoIdentityByIssuerSubject(db: Db, issuer: string, subject: string) {
  return db.query<{ user_id: string }>(
    'SELECT user_id FROM sso_identities WHERE issuer=$1 AND subject=$2',
    [issuer, subject],
  );
}

export async function findActiveSsoUserById(db: Db, userId: string) {
  return db.query<{ id: string }>(
    "SELECT id FROM users WHERE id=$1 AND active AND auth_mode IN ('SSO','BOTH') FOR UPDATE",
    [userId],
  );
}

export async function findSsoIdentityMapping(
  db: Db,
  issuer: string,
  subject: string,
  userId: string,
) {
  return db.query<{ id: string }>(
    'SELECT id FROM sso_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3',
    [issuer, subject, userId],
  );
}

export async function findUserForSsoUpdate(db: Db, userId: string) {
  return db.query<{ id: string }>('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
}

export async function insertSsoIdentity(db: Db, userId: string, issuer: string, subject: string) {
  return db.query<{ id: string; user_id: string; issuer: string; subject: string }>(
    'INSERT INTO sso_identities(user_id,issuer,subject) VALUES($1,$2,$3) RETURNING id,user_id,issuer,subject',
    [userId, issuer, subject],
  );
}

export async function updateUserAuthMode(db: Db, userId: string, authMode: 'SSO' | 'BOTH') {
  return db.query('UPDATE users SET auth_mode=$2 WHERE id=$1', [userId, authMode]);
}

export async function findSsoIdentitiesByUserId(db: Db, userId: string) {
  return db.query<SsoIdentity>(
    'SELECT id,user_id,issuer,subject,created_at FROM sso_identities WHERE user_id=$1',
    [userId],
  );
}

export async function findSsoIdentityById(db: Db, id: string) {
  return db.query<{ user_id: string }>('SELECT user_id FROM sso_identities WHERE id=$1', [id]);
}

export async function deleteSsoIdentity(db: Db, id: string) {
  return db.query('DELETE FROM sso_identities WHERE id=$1', [id]);
}
