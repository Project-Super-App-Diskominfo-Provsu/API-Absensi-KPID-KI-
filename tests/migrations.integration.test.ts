import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPool } from '../src/database/client.js';
import { migrateDatabase, verifyDatabaseSchema } from '../src/database/migrate.js';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://absensi:local-development-only@localhost:55432/absensi';
const admin = new Pool({ connectionString: adminUrl });
let databaseName: string;
let pool: Pool;
let fixtureDirectory: string | undefined;

beforeEach(async () => {
  databaseName = `absensi_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  pool = createPool(url.toString());
});

afterEach(async () => {
  await pool?.end();
  // pg-pool can resolve end() before PostgreSQL finishes closing the sockets.
  for (let attempt = 0; attempt < 100; attempt++) {
    const sessions = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [
      databaseName,
    ]);
    if (!sessions.rowCount) break;
    await setTimeout(20);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { recursive: true, force: true });
    fixtureDirectory = undefined;
  }
});
afterAll(async () => {
  await admin.end();
});

describe('database migrations', () => {
  it('upgrades the portable baseline to PostGIS without changing existing coordinates or data', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-portable-upgrade-'));
    for (const name of ['001_initial_postgres.sql', '002_sso.sql', '003_office_coordinates.sql']) {
      await copyFile(
        new URL('../migrations/' + name, import.meta.url),
        join(fixtureDirectory, name),
      );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    await pool.query("INSERT INTO units(name) VALUES ('preserved')");
    await pool.query('UPDATE offices SET latitude=3.5,longitude=98.6');
    const offices = (await pool.query('SELECT * FROM offices ORDER BY id')).rows;
    const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    expect((await pool.query("SELECT 1 FROM pg_extension WHERE extname='postgis'")).rowCount).toBe(
      0,
    );
    expect(await migrateDatabase(pool)).toEqual([
      '004_postgis_geofencing.sql',
      '005_office_polygon.sql',
      '006_office_geofence_policy.sql',
      '007_office_map_centers.sql',
    ]);
    const afterOffices = (await pool.query('SELECT * FROM offices ORDER BY id')).rows;
    expect(afterOffices.map(({ polygon, address, ...rest }) => rest)).toEqual(offices);
    expect(afterOffices.every((row) => row.polygon !== null)).toBe(true);
    expect((await pool.query("SELECT * FROM units WHERE name='preserved'")).rowCount).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT * FROM schema_migrations WHERE name NOT IN ('004_postgis_geofencing.sql', '005_office_polygon.sql', '006_office_geofence_policy.sql', '007_office_map_centers.sql') ORDER BY name",
        )
      ).rows,
    ).toEqual(ledger);
    expect((await pool.query('SELECT PostGIS_Version() AS version')).rows[0].version).toBeTruthy();
    await verifyDatabaseSchema(pool);
    expect(await migrateDatabase(pool)).toEqual([]);
  });

  it('rejects conflicting baseline histories rather than guessing which data to adopt', async () => {
    await migrateDatabase(pool);
    await pool.query(
      "INSERT INTO schema_migrations(name,checksum) VALUES ('001_initial.sql','conflicting')",
    );
    await expect(migrateDatabase(pool)).rejects.toThrow('Conflicting migration baselines');
    await expect(verifyDatabaseSchema(pool)).rejects.toThrow('Conflicting migration baselines');
  });

  it('enforces coordinate pairs, bounds and active-office configuration in PostgreSQL', async () => {
    await migrateDatabase(pool);
    await pool.query('UPDATE offices SET latitude=NULL,longitude=NULL,polygon=NULL');
    for (const sql of [
      'UPDATE offices SET latitude=3.5',
      'UPDATE offices SET latitude=91,longitude=98.6',
      'UPDATE offices SET latitude=3.5,longitude=181',
      'UPDATE offices SET latitude=0,longitude=0',
      'UPDATE offices SET active=true',
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' });
  });

  it('checks every required checksum while tolerating additive migrations from newer replicas', async () => {
    await expect(verifyDatabaseSchema(pool)).rejects.toMatchObject({ code: '42P01' });
    await migrateDatabase(pool);
    await expect(verifyDatabaseSchema(pool)).resolves.toBeUndefined();
    await pool.query(
      "INSERT INTO schema_migrations(name,checksum) VALUES ('003_future.sql','future')",
    );
    await expect(verifyDatabaseSchema(pool)).resolves.toBeUndefined();
    await pool.query("DELETE FROM schema_migrations WHERE name='002_sso.sql'");
    await expect(verifyDatabaseSchema(pool)).rejects.toThrow('002_sso.sql');
    await pool.query(
      "UPDATE schema_migrations SET checksum='changed' WHERE name='001_initial_postgres.sql'",
    );
    await expect(verifyDatabaseSchema(pool)).rejects.toThrow('001_initial_postgres.sql');
  });

  it('uses DDL timeouts only inside the migration transaction', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-migration-timeout-'));
    await writeFile(
      join(fixtureDirectory, '001_timeout.sql'),
      "DO $$ BEGIN IF current_setting('statement_timeout') <> '2min' THEN RAISE EXCEPTION 'wrong migration timeout'; END IF; END $$;",
    );
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('10s');
    expect((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  });

  it('initializes an empty database with the complete auth schema and ledger', async () => {
    expect(await migrateDatabase(pool)).toEqual([
      '001_initial_postgres.sql',
      '002_sso.sql',
      '003_office_coordinates.sql',
      '004_postgis_geofencing.sql',
      '005_office_polygon.sql',
      '006_office_geofence_policy.sql',
      '007_office_map_centers.sql',
    ]);
    expect((await pool.query('SELECT name,checksum FROM schema_migrations')).rowCount).toBe(7);
    await expect(
      pool.query(
        'SELECT u.auth_mode,s.expires_at FROM users u LEFT JOIN refresh_sessions s ON false LIMIT 0',
      ),
    ).resolves.toBeDefined();
    expect((await pool.query('SELECT * FROM offices')).rowCount).toBe(3);
  });

  it('seeds the supplied office pins with valid 50m polygons and the category permissions', async () => {
    await migrateDatabase(pool);
    const rows = (
      await pool.query(
        `SELECT code,latitude,longitude,active,radius_m,ST_IsValid(polygon) AS valid,
      ST_Covers(polygon,ST_SetSRID(ST_MakePoint(longitude,latitude),4326)) AS covers_center,
      ST_Distance(ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography,
        ST_PointN(ST_ExteriorRing(polygon),1)::geography) AS edge_distance
      FROM offices ORDER BY code`,
      )
    ).rows;
    expect(rows.map(({ code, latitude, longitude }) => ({ code, latitude, longitude }))).toEqual([
      { code: 'DISKOMINFO_PROVSU', latitude: 3.601785, longitude: 98.682827 },
      { code: 'KI_SUMUT', latitude: 3.5464663, longitude: 98.6946129 },
      { code: 'KPID_SUMUT', latitude: 3.601287, longitude: 98.6823199 },
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ active: false, radius_m: 50, valid: true, covers_center: true });
      expect(row.edge_distance).toBeCloseTo(50, 0);
    }
    expect(
      (
        await pool.query(
          `SELECT p.employee_category_code AS category,o.code FROM category_office_permissions p
      JOIN offices o ON o.id=p.office_id ORDER BY category,o.code`,
        )
      ).rows,
    ).toEqual([
      { category: 'KI', code: 'DISKOMINFO_PROVSU' },
      { category: 'KI', code: 'KI_SUMUT' },
      { category: 'KPID', code: 'DISKOMINFO_PROVSU' },
      { category: 'KPID', code: 'KPID_SUMUT' },
    ]);
  });

  it('skips applied migrations on restart and preserves existing data', async () => {
    await migrateDatabase(pool);
    const id = (await pool.query("INSERT INTO units(name) VALUES ('Existing unit') RETURNING id"))
      .rows[0].id;
    const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    expect(await migrateDatabase(pool)).toEqual([]);
    expect(
      (await pool.query('SELECT id FROM units WHERE name=$1', ['Existing unit'])).rows[0].id,
    ).toBe(id);
    expect((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
      ledger,
    );
  });

  it('serializes simultaneous migrations from multiple replicas', async () => {
    const results = await Promise.all([migrateDatabase(pool), migrateDatabase(pool)]);
    expect(results.map((names) => names.length).sort()).toEqual([0, 7]);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(7);
    expect((await pool.query('SELECT * FROM offices')).rowCount).toBe(3);
  });

  it('rejects changed checksums without changing existing application data', async () => {
    await migrateDatabase(pool);
    await pool.query("INSERT INTO units(name) VALUES ('Preserved unit')");
    await pool.query(
      "UPDATE schema_migrations SET checksum='tampered' WHERE name='001_initial_postgres.sql'",
    );
    await expect(migrateDatabase(pool)).rejects.toThrow(
      'Applied migration changed: 001_initial_postgres.sql',
    );
    expect((await pool.query("SELECT * FROM units WHERE name='Preserved unit'")).rowCount).toBe(1);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(7);
  });

  it('rolls back all pending schema changes and the ledger if any SQL fails', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-migration-failure-'));
    await writeFile(
      join(fixtureDirectory, '001_create.sql'),
      'CREATE TABLE partial_change(id int);',
    );
    await writeFile(join(fixtureDirectory, '002_fail.sql'), 'SELECT * FROM missing_test_relation;');
    await expect(
      migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/')),
    ).rejects.toMatchObject({
      code: '42P01',
    });
    const row = (
      await pool.query(
        "SELECT to_regclass('partial_change') AS partial, to_regclass('schema_migrations') AS ledger",
      )
    ).rows[0];
    expect(row).toEqual({ partial: null, ledger: null });
  });

  it('does not silently adopt or overwrite an existing schema without a ledger', async () => {
    await pool.query('CREATE TABLE users(id int PRIMARY KEY, preserved text)');
    await pool.query("INSERT INTO users VALUES (1,'existing data')");
    await expect(migrateDatabase(pool)).rejects.toMatchObject({ code: '42P07' });
    expect((await pool.query('SELECT * FROM users')).rows).toEqual([
      { id: 1, preserved: 'existing data' },
    ]);
    expect(
      (await pool.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger,
    ).toBeNull();
  });
});
