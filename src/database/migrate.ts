import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from './client.js';

export class SchemaVerificationError extends Error {
  constructor(public readonly migration: string) {
    super(
      `Missing or changed migration: ${migration}. Run npm run db:migrate or npm run db:migrate:production.`,
    );
  }
}

async function readMigrations(directory: URL) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error('No SQL migrations found. Include migrations in the image.');
  return Promise.all(
    names.map(async (name) => {
      const original = await readFile(new URL(name, directory), 'utf8');
      const sql = original.replaceAll('\r\n', '\n');
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const checksum = digest(sql);
      // Existing ledgers retain their original bytes' checksum across Windows/Linux.
      const checksums = new Set([checksum, digest(sql.replaceAll('\n', '\r\n')), digest(original)]);
      return { name, sql, checksum, checksums };
    }),
  );
}

function migrationPlan<T extends { name: string }>(migrations: T[], applied: Map<string, string>) {
  // Existing deployments keep their original checksummed baseline. Fresh databases
  // use the independent portable baseline; never rewrite historical ledger entries.
  if (applied.has('001_initial.sql') && applied.has('001_initial_postgres.sql'))
    throw new Error('Conflicting migration baselines. Review schema_migrations before deployment.');
  const legacy = applied.has('001_initial.sql');
  return migrations.filter(
    ({ name }) =>
      name !== (legacy ? '001_initial_postgres.sql' : '001_initial.sql') ||
      !migrations.some((migration) => migration.name === '001_initial_postgres.sql'),
  );
}

export async function verifyDatabaseSchema(
  pool: Pool,
  directory = new URL('../../migrations/', import.meta.url),
): Promise<void> {
  const migrations = await readMigrations(directory);
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name,checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  for (const { name, checksums } of migrationPlan(migrations, applied)) {
    if (!checksums.has(applied.get(name) ?? '')) throw new SchemaVerificationError(name);
  }
}

export async function migrateDatabase(
  pool: Pool,
  directory = new URL('../../migrations/', import.meta.url),
): Promise<string[]> {
  const migrations = await readMigrations(directory);
  return transaction(pool, async (db) => {
    // API query deadlines are too short for DDL and replica lock contention.
    await db.query("SET LOCAL statement_timeout = '120s'");
    await db.query("SET LOCAL lock_timeout = '60s'");
    await db.query('SELECT pg_advisory_xact_lock(8123481)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())',
    );
    const ledger = await db.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM schema_migrations',
    );
    const known = new Map(ledger.rows.map((row) => [row.name, row.checksum]));
    const applied: string[] = [];
    for (const { name, sql, checksum, checksums } of migrationPlan(migrations, known)) {
      const old = await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (old.rowCount) {
        if (!checksums.has(old.rows[0].checksum))
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      try {
        await db.query(sql);
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { migration: name });
        throw error;
      }
      await db.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [
        name,
        checksum,
      ]);
      applied.push(name);
    }
    return applied;
  });
}
