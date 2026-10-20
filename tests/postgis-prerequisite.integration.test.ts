import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../src/database/client.js';
import { migrateDatabase } from '../src/database/migrate.js';

describe.skipIf(!process.env.TEST_PLAIN_DATABASE_URL)('PostgreSQL without PostGIS', () => {
  const admin = new Pool({ connectionString: process.env.TEST_PLAIN_DATABASE_URL });
  const databaseName = `absensi_no_postgis_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.TEST_PLAIN_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    pool = createPool(url.toString());
    await pool.query('CREATE TABLE preservation_fixture(value text)');
    await pool.query("INSERT INTO preservation_fixture VALUES ('preserved')");
  });
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  it('reproduces SQLSTATE 0A000 for the original extension statement', async () => {
    await expect(pool.query('CREATE EXTENSION IF NOT EXISTS postgis')).rejects.toMatchObject({
      code: '0A000',
    });
  });

  it('reports missing PostGIS clearly and rolls back the migration ledger', async () => {
    await expect(migrateDatabase(pool)).rejects.toMatchObject({
      code: 'POSTGIS_NOT_AVAILABLE',
      migration: '001_initial.sql',
    });
    const row = (
      await pool.query(
        "SELECT to_regclass('schema_migrations') AS ledger, to_regclass('users') AS users",
      )
    ).rows[0];
    expect(row).toEqual({ ledger: null, users: null });
    expect((await pool.query('SELECT * FROM preservation_fixture')).rows).toEqual([
      { value: 'preserved' },
    ]);
  });
});
