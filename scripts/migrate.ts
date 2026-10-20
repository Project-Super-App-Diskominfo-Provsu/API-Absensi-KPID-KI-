import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPool, transaction } from '../src/database/client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const pool = createPool(url);
try {
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(8123481)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())',
    );
    for (const name of (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (old.rowCount) {
        if (old.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [
        name,
        checksum,
      ]);
      console.log(`Applied ${name}`);
    }
  });
} finally {
  await pool.end();
}
