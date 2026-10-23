import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPool } from '../src/database/client.js';
import { migrateDatabase, verifyDatabaseSchema } from '../src/database/migrate.js';

describe.skipIf(!process.env.TEST_LEGACY_DATABASE_URL)('legacy PostGIS upgrade', () => {
  const admin = new Pool({ connectionString: process.env.TEST_LEGACY_DATABASE_URL });
  const databaseName = `absensi_legacy_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let fixture: string;
  let officeId: string;
  let ledger: unknown[];

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.TEST_LEGACY_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    pool = createPool(url.toString());
    fixture = await mkdtemp(join(tmpdir(), 'absensi-legacy-'));
    for (const name of ['001_initial.sql', '002_sso.sql'])
      await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(fixture, name));
    await migrateDatabase(pool, pathToFileURL(fixture + '/'));
    officeId = (await pool.query("SELECT id FROM offices WHERE code='KPID_SUMUT'")).rows[0].id;
    await pool.query(
      `UPDATE offices SET location=ST_SetSRID(ST_MakePoint(98.61,3.5),4326)::geography,
      max_gps_accuracy_m=15,max_location_age_s=30,active=true WHERE id=$1`,
      [officeId],
    );
    await pool.query("INSERT INTO units(name) VALUES ('Preserved legacy unit')");
    ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  });
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  it('backfills coordinates and preserves original checksums, seed IDs and application data', async () => {
    expect(await migrateDatabase(pool)).toEqual([
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
    expect(
      (
        await pool.query(
          'SELECT * FROM schema_migrations WHERE name NOT IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ORDER BY name',
          [
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
          ],
        )
      ).rows,
    ).toEqual(ledger);
    expect(
      (await pool.query('SELECT id,latitude,longitude,active FROM offices WHERE id=$1', [officeId]))
        .rows[0],
    ).toEqual({ id: officeId, latitude: 3.5, longitude: 98.61, active: true });
    expect(
      (await pool.query("SELECT * FROM units WHERE name='Preserved legacy unit'")).rowCount,
    ).toBe(1);
    await expect(verifyDatabaseSchema(pool)).resolves.toBeUndefined();
    expect(await migrateDatabase(pool)).toEqual([]);
    await expect(verifyDatabaseSchema(pool, pathToFileURL(fixture + '/'))).resolves.toBeUndefined();
    expect(await migrateDatabase(pool, pathToFileURL(fixture + '/'))).toEqual([]);
  });

  it('synchronizes legacy and numeric writers for mixed-version operation and image rollback', async () => {
    await pool.query('UPDATE offices SET longitude=98.62,latitude=3.6 WHERE id=$1', [officeId]);
    expect(
      (
        await pool.query(
          'SELECT ST_X(location::geometry) AS lon,ST_Y(location::geometry) AS lat FROM offices WHERE id=$1',
          [officeId],
        )
      ).rows[0],
    ).toEqual({ lon: 98.62, lat: 3.6 });
    await pool.query(
      'UPDATE offices SET location=ST_SetSRID(ST_MakePoint(98.63,3.7),4326)::geography WHERE id=$1',
      [officeId],
    );
    expect(
      (await pool.query('SELECT longitude,latitude FROM offices WHERE id=$1', [officeId])).rows[0],
    ).toEqual({ longitude: 98.63, latitude: 3.7 });
    await pool.query('UPDATE offices SET active=false,latitude=NULL,longitude=NULL WHERE id=$1', [
      officeId,
    ]);
    expect(
      (await pool.query('SELECT location FROM offices WHERE id=$1', [officeId])).rows[0].location,
    ).toBeNull();
    await pool.query(
      'UPDATE offices SET location=ST_SetSRID(ST_MakePoint(98.61,3.5),4326)::geography WHERE id=$1',
      [officeId],
    );
    expect(
      (await pool.query('SELECT latitude FROM offices WHERE id=$1', [officeId])).rows[0].latitude,
    ).toBe(3.5);
  });
});
