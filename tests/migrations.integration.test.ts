import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  it('adds notification tables without changing existing users or sessions', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-notification-upgrade-'));
    for (const name of await readdir(new URL('../migrations/', import.meta.url))) {
      if (name.endsWith('.sql') && name < '012_')
        await copyFile(
          new URL('../migrations/' + name, import.meta.url),
          join(fixtureDirectory, name),
        );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    const user = (
      await pool.query(
        "INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code) VALUES('PUSH1','Existing','preserved@example.test','fixture','EMPLOYEE','KPID') RETURNING id",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO refresh_sessions(user_id,family_id,token_hash,expires_at) VALUES($1,$2,'existing-push-session',now()+interval '30 days')",
      [user.id, randomUUID()],
    );
    const beforeUsers = (await pool.query('SELECT * FROM users')).rows;
    const beforeSessions = (await pool.query('SELECT * FROM refresh_sessions')).rows;
    expect(await migrateDatabase(pool)).toEqual([
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    expect((await pool.query('SELECT * FROM users')).rows).toEqual(beforeUsers);
    expect((await pool.query('SELECT * FROM refresh_sessions')).rows).toEqual(beforeSessions);
    expect((await pool.query('SELECT 1 FROM device_push_tokens')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM notification_deliveries')).rowCount).toBe(0);
  });
  it('adds holidays and leave requests tables without changing existing users or schedules', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-holiday-upgrade-'));
    for (const name of await readdir(new URL('../migrations/', import.meta.url))) {
      if (name.endsWith('.sql') && name < '013_')
        await copyFile(
          new URL('../migrations/' + name, import.meta.url),
          join(fixtureDirectory, name),
        );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    const beforeUsers = (await pool.query('SELECT * FROM users')).rows;
    expect(await migrateDatabase(pool)).toEqual(['013_holidays_and_leaves.sql']);
    expect((await pool.query('SELECT * FROM users')).rows).toEqual(beforeUsers);
    expect((await pool.query('SELECT 1 FROM holidays')).rowCount).toBeGreaterThan(0);
    expect((await pool.query('SELECT 1 FROM leave_requests')).rowCount).toBe(0);
  });
  it('adds one-time Google email permission without enabling existing accounts or changing profiles', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-email-upgrade-'));
    for (const name of await readdir(new URL('../migrations/', import.meta.url))) {
      if (name.endsWith('.sql') && name < '011_')
        await copyFile(
          new URL('../migrations/' + name, import.meta.url),
          join(fixtureDirectory, name),
        );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    await pool.query(
      "INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code,auth_mode) VALUES('PRESERVE','Existing Employee','employee@gmail.com','fixture','EMPLOYEE','KI','BOTH')",
    );
    const before = (await pool.query('SELECT * FROM users')).rows[0];
    expect(await migrateDatabase(pool)).toEqual([
      '011_google_email_linking.sql',
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    const { google_email_linking_allowed, ...after } = (await pool.query('SELECT * FROM users'))
      .rows[0];
    expect(google_email_linking_allowed).toBe(false);
    expect(after).toEqual(before);
  });
  it('preserves existing refresh sessions as MOBILE when adding web and Google authentication', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-web-upgrade-'));
    for (const name of await readdir(new URL('../migrations/', import.meta.url))) {
      if (name.endsWith('.sql') && name < '010_')
        await copyFile(
          new URL('../migrations/' + name, import.meta.url),
          join(fixtureDirectory, name),
        );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    const user = (
      await pool.query(
        "INSERT INTO users(employee_number,name,email,password_hash,role) VALUES('OLD1','Existing','existing@example.test','fixture','SUPER_ADMIN') RETURNING id",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO refresh_sessions(user_id,family_id,token_hash,expires_at) VALUES($1,$2,'preserved-hash',now()+interval '30 days')",
      [user.id, randomUUID()],
    );
    const before = (await pool.query('SELECT * FROM refresh_sessions')).rows[0];
    expect(await migrateDatabase(pool)).toEqual([
      '010_web_and_google_auth.sql',
      '011_google_email_linking.sql',
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    const { client_type, ...after } = (await pool.query('SELECT * FROM refresh_sessions')).rows[0];
    expect(client_type).toBe('MOBILE');
    expect(after).toEqual(before);
    await expect(verifyDatabaseSchema(pool)).resolves.toBeUndefined();
    expect(await migrateDatabase(pool)).toEqual([]);
  });
  it.each(['LF', 'CRLF'])(
    'preserves a legacy %s ledger across line-ending changes and rejects SQL edits',
    async (format) => {
      fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-eol-upgrade-'));
      const lf =
        'CREATE TABLE preserved_note(id int PRIMARY KEY);\nINSERT INTO preserved_note VALUES (1);\n';
      const crlf = lf.replaceAll('\n', '\r\n');
      const original = format === 'LF' ? lf : crlf;
      const name = '001_line_endings.sql';
      // Simulate the byte-based checksums written by the previous migrator.
      await pool.query(
        'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())',
      );
      await pool.query(original);
      await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        name,
        createHash('sha256').update(original).digest('hex'),
      ]);
      const ledger = (await pool.query('SELECT * FROM schema_migrations')).rows;
      await writeFile(join(fixtureDirectory, name), format === 'LF' ? crlf : lf);
      const directory = pathToFileURL(fixtureDirectory + '/');
      expect(await migrateDatabase(pool, directory)).toEqual([]);
      await expect(verifyDatabaseSchema(pool, directory)).resolves.toBeUndefined();
      expect((await pool.query('SELECT * FROM schema_migrations')).rows).toEqual(ledger);
      expect((await pool.query('SELECT * FROM preserved_note')).rows).toEqual([{ id: 1 }]);
      await writeFile(join(fixtureDirectory, name), lf.replace('VALUES (1)', 'VALUES (2)'));
      await expect(migrateDatabase(pool, directory)).rejects.toThrow(
        'Applied migration changed: ' + name,
      );
      await expect(verifyDatabaseSchema(pool, directory)).rejects.toThrow(
        'Missing or changed migration: ' + name,
      );
      expect((await pool.query('SELECT * FROM schema_migrations')).rows).toEqual(ledger);
      expect((await pool.query('SELECT * FROM preserved_note')).rows).toEqual([{ id: 1 }]);
    },
  );

  it('writes canonical LF checksums for new migrations even from a CRLF checkout', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-eol-new-'));
    const lf = 'CREATE TABLE canonical_note(id int);\n';
    await writeFile(join(fixtureDirectory, '001_canonical.sql'), lf.replaceAll('\n', '\r\n'));
    const directory = pathToFileURL(fixtureDirectory + '/');
    expect(await migrateDatabase(pool, directory)).toEqual(['001_canonical.sql']);
    expect((await pool.query('SELECT checksum FROM schema_migrations')).rows[0].checksum).toBe(
      createHash('sha256').update(lf).digest('hex'),
    );
    await writeFile(join(fixtureDirectory, '001_canonical.sql'), lf);
    await expect(verifyDatabaseSchema(pool, directory)).resolves.toBeUndefined();
    expect(await migrateDatabase(pool, directory)).toEqual([]);
  });

  it('refuses an overnight schedule upgrade without changing schedules, users or the previous ledger', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'absensi-schedule-upgrade-'));
    for (const name of await readdir(new URL('../migrations/', import.meta.url))) {
      if (name.endsWith('.sql') && name < '008_')
        await copyFile(
          new URL('../migrations/' + name, import.meta.url),
          join(fixtureDirectory, name),
        );
    }
    await migrateDatabase(pool, pathToFileURL(fixtureDirectory + '/'));
    const user = (
      await pool.query(
        "INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code) VALUES('QA1','QA','qa@example.test','fixture','EMPLOYEE','KPID') RETURNING id",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO work_schedules(user_id,work_date,starts_at,ends_at) VALUES($1,'2035-01-01','2035-01-01T22:00:00+07:00','2035-01-02T06:00:00+07:00')",
      [user.id],
    );
    const schedules = (await pool.query('SELECT * FROM work_schedules')).rows;
    const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    await expect(migrateDatabase(pool)).rejects.toThrow(
      'Cross-date schedules exist. Review work_schedules',
    );
    expect((await pool.query('SELECT * FROM work_schedules')).rows).toEqual(schedules);
    expect((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
      ledger,
    );
    expect(
      (
        await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='face_enrollment_version'",
        )
      ).rowCount,
    ).toBe(0);
    await pool.query("UPDATE work_schedules SET ends_at='2035-01-01T23:59:00+07:00'");
    const corrected = (await pool.query('SELECT * FROM work_schedules')).rows;
    expect(await migrateDatabase(pool)).toEqual([
      '008_face_enrollment_version.sql',
      '009_same_day_schedules.sql',
      '010_web_and_google_auth.sql',
      '011_google_email_linking.sql',
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    expect((await pool.query('SELECT * FROM work_schedules')).rows).toEqual(corrected);
    expect(
      (await pool.query('SELECT face_enrollment_version FROM users WHERE id=$1', [user.id])).rows,
    ).toEqual([{ face_enrollment_version: 0 }]);
    await expect(
      pool.query("UPDATE work_schedules SET ends_at='2035-01-02T06:00:00+07:00'"),
    ).rejects.toMatchObject({ code: '23514', constraint: 'work_schedules_same_day' });
    await expect(verifyDatabaseSchema(pool)).resolves.toBeUndefined();
    expect(await migrateDatabase(pool)).toEqual([]);
  });

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
      '008_face_enrollment_version.sql',
      '009_same_day_schedules.sql',
      '010_web_and_google_auth.sql',
      '011_google_email_linking.sql',
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    const afterOffices = (await pool.query('SELECT * FROM offices ORDER BY id')).rows;
    expect(afterOffices.map(({ polygon, address, ...rest }) => rest)).toEqual(offices);
    expect(afterOffices.every((row) => row.polygon !== null)).toBe(true);
    expect((await pool.query("SELECT * FROM units WHERE name='preserved'")).rowCount).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT * FROM schema_migrations WHERE name NOT IN ('004_postgis_geofencing.sql', '005_office_polygon.sql', '006_office_geofence_policy.sql', '007_office_map_centers.sql', '008_face_enrollment_version.sql', '009_same_day_schedules.sql', '010_web_and_google_auth.sql', '011_google_email_linking.sql', '012_checkin_notifications.sql', '013_holidays_and_leaves.sql') ORDER BY name",
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
      '008_face_enrollment_version.sql',
      '009_same_day_schedules.sql',
      '010_web_and_google_auth.sql',
      '011_google_email_linking.sql',
      '012_checkin_notifications.sql',
      '013_holidays_and_leaves.sql',
    ]);
    expect((await pool.query('SELECT name,checksum FROM schema_migrations')).rowCount).toBe(13);
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
    expect(results.map((names) => names.length).sort()).toEqual([0, 12]);
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(12);
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
    expect((await pool.query('SELECT * FROM schema_migrations')).rowCount).toBe(12);
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
