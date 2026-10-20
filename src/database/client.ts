import { Pool, type PoolClient } from 'pg';
export type Db = Pool | PoolClient;
export function createPool(url: string) {
  return new Pool({
    connectionString: url,
    max: 15,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
}
export async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}
