import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { hash } from '../../shared/security/crypto.js';
import { fail } from '../../shared/errors/api-error.js';
import { logoutUser } from './auth.service.js';

export function webCsrfToken(config: Config, refresh: string) {
  return createHmac('sha256', config.JWT_SECRET)
    .update('web-csrf:' + refresh)
    .digest('base64url');
}

export function verifyWebCsrf(config: Config, refresh: string, candidate?: string) {
  const expected = Buffer.from(webCsrfToken(config, refresh));
  const supplied = Buffer.from(candidate ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    fail(403, 'CSRF_INVALID', 'Token CSRF tidak valid.');
}

export async function checkWebSession(pool: Pool, refresh: string) {
  const result = await pool.query(
    `SELECT s.id FROM refresh_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.client_type='WEB' AND s.revoked_at IS NULL AND s.expires_at>now()
    AND u.active AND u.role IN ('ADMIN','SUPER_ADMIN')`,
    [hash(refresh)],
  );
  if (!result.rowCount) fail(401, 'REFRESH_INVALID', 'Sesi web tidak valid. Silakan login ulang.');
}

export async function logoutWebSession(pool: Pool, refresh: string) {
  const row = await pool.query<{ id: string }>(
    "SELECT id FROM refresh_sessions WHERE token_hash=$1 AND client_type='WEB'",
    [hash(refresh)],
  );
  if (row.rowCount) await logoutUser(pool, row.rows[0]!.id);
}
