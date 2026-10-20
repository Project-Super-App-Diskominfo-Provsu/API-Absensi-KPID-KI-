import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from './client.js';
import { requirePostgis } from './postgis.js';

export async function migrateDatabase(
  pool: Pool,
  directory = new URL('../../migrations/', import.meta.url),
): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error('No SQL migrations found. Include migrations in the image.');
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(8123481)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())',
    );
    const applied: string[] = [];
    for (const { name, sql, checksum } of migrations) {
      const old = await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (old.rowCount) {
        if (old.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      if (/\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?postgis\b/i.test(sql)) {
        await requirePostgis(db, name);
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [
        name,
        checksum,
      ]);
      applied.push(name);
    }
    return applied;
  });
}
