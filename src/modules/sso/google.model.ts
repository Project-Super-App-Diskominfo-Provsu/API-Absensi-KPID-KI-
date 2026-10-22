import type { Db } from '../../database/client.js';

export interface GoogleFlow {
  id: string;
  client_type: 'MOBILE' | 'WEB';
  nonce: string;
  code_verifier: string | null;
}

export async function insertGoogleFlow(
  db: Db,
  nonce: string,
  clientType: 'MOBILE' | 'WEB',
  stateHash?: string,
  browserHash?: string,
  verifier?: string,
) {
  return db.query<{ id: string; expires_at: Date }>(
    'INSERT INTO google_login_flows(nonce,client_type,state_hash,browser_hash,code_verifier) VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at',
    [nonce, clientType, stateHash ?? null, browserHash ?? null, verifier ?? null],
  );
}

export async function consumeGoogleMobileFlow(db: Db, id: string) {
  return db.query<GoogleFlow>(
    "UPDATE google_login_flows SET consumed_at=now() WHERE id=$1 AND client_type='MOBILE' AND consumed_at IS NULL AND expires_at>now() RETURNING id,client_type,nonce,code_verifier",
    [id],
  );
}

export async function consumeGoogleWebFlow(db: Db, stateHash: string, browserHash: string) {
  return db.query<GoogleFlow>(
    "UPDATE google_login_flows SET consumed_at=now() WHERE state_hash=$1 AND browser_hash=$2 AND client_type='WEB' AND consumed_at IS NULL AND expires_at>now() RETURNING id,client_type,nonce,code_verifier",
    [stateHash, browserHash],
  );
}
