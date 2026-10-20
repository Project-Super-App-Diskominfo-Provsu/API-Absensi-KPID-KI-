import { Pool, type PoolClient } from 'pg';
export type Db = Pool | PoolClient;
export function createPool(url: string, max = 15) {
  return new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30000,
    idle_in_transaction_session_timeout: 15000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
}
export async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw err;
  } finally {
    db.release(discard);
  }
}
