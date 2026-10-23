import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { migrateDatabase } from '../src/database/migrate.js';
import { Pool } from 'pg';
import { createRedisClient } from '../src/database/redis.js';
import request from 'supertest';
import argon2 from 'argon2';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import { encrypt, hash } from '../src/shared/security/crypto.js';
import { selectOffice } from '../src/modules/office/office.service.js';
import { attendancePayload } from '../src/modules/attendance/attendance.service.js';
import { attendanceInput } from '../src/modules/attendance/attendance.schema.js';
import type { FaceEngine } from '../src/modules/face/face.types.js';
import { issueSession, logoutUser } from '../src/modules/auth/auth.service.js';
import { googleEmailForLinking } from '../src/modules/sso/google.service.js';
import { processCheckInReminders } from '../src/modules/notification/notification.service.js';
import { enqueueReminders, claimReminder } from '../src/modules/notification/notification.model.js';
import type { ReminderMessage } from '../src/modules/notification/notification.sender.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const databaseName = `absensi_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://absensi:local-development-only@localhost:55432/absensi';
const adminPool = new Pool({ connectionString: adminUrl });
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const pool = new Pool({ connectionString: testUrl.toString(), max: 15 });
const redis = createRedisClient(process.env.TEST_REDIS_URL ?? 'redis://localhost:56379');
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: testUrl.toString(),
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:56379',
  JWT_SECRET: 't'.repeat(40),
  BIOMETRIC_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  FACE_MODEL_VERSION: 'fixture-model',
  FACE_WORKER_TOKEN: 'w'.repeat(40),
  FACE_MATCH_THRESHOLD: '0.8',
  FACE_REVIEW_THRESHOLD: '0.6',
  FACE_LIVENESS_THRESHOLD: '0.9',
  FACE_QUALITY_THRESHOLD: '0.7',
});
const embedding: number[] = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
let observation = {
  embedding,
  model_version: 'fixture-model',
  quality_score: 0.99,
  liveness_score: 0.99,
};
let workerError = false;
let workerHook: ((nonce: string) => Promise<void>) | undefined;
const engine: FaceEngine = {
  ready: async () => true,
  observe: async (_image, nonce) => {
    await workerHook?.(nonce);
    if (workerError) throw new Error('offline');
    return observation;
  },
};
let app: ReturnType<typeof createApp>;
let passwordHash: string, image: Buffer;
let user: string, admin: string, access: string, adminAccess: string, device: string;
let offices: Record<string, string> = {};
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
async function login(email: string) {
  return request(app).post('/api/v1/auth/login').send({ email, password: 'test-password-123' });
}
async function challenge(purpose = 'CHECK_IN') {
  const result = await request(app)
    .post('/api/v1/attendance/challenges')
    .auth(access, { type: 'bearer' })
    .send({ device_id: device, purpose });
  expect(result.status, result.text).toBe(201);
  return result.body.data.nonce as string;
}
async function capture(
  purpose: 'CHECK_IN' | 'CHECK_OUT' = 'CHECK_IN',
  options: Record<string, string> = {},
  key = randomUUID(),
  nonce?: string,
) {
  const fields = {
    latitude: '3.5',
    longitude: '98.6',
    accuracy_m: '5',
    captured_at: new Date().toISOString(),
    device_id: device,
    nonce: nonce ?? (await challenge(purpose)),
    is_mock: 'false',
    ...options,
  };
  const parsed = attendanceInput.parse({ ...fields, signature: 's'.repeat(60) });
  const signature = sign(
    null,
    Buffer.from(attendancePayload(user, purpose, key, parsed, image)),
    pair.privateKey,
  ).toString('base64');
  const send = () => {
    let req = request(app)
      .post(`/api/v1/attendance/${purpose === 'CHECK_IN' ? 'check-in' : 'check-out'}`)
      .auth(access, { type: 'bearer' })
      .set('Idempotency-Key', key);
    for (const [field, value] of Object.entries({ ...fields, signature }))
      req = req.field(field, value);
    return req.attach('image', image, 'selfie.png');
  };
  return { send, key, fields };
}

async function enrollment() {
  const nonce = await challenge('ENROLL');
  const images = await Promise.all(
    ['#c0a081', '#c0a082', '#c0a083'].map((background) =>
      sharp({ create: { width: 128, height: 128, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  const signature = sign(
    null,
    Buffer.from(`enroll:${user}:${device}:${nonce}:pilot-v1:${images.map(hash).join(':')}`),
    pair.privateKey,
  ).toString('base64');
  const send = () => {
    let req = request(app)
      .post('/api/v1/face/enroll')
      .auth(access, { type: 'bearer' })
      .field('device_id', device)
      .field('nonce', nonce)
      .field('consent', 'true')
      .field('consent_version', 'pilot-v1')
      .field('signature', signature);
    for (const [index, photo] of images.entries())
      req = req.attach('images', photo, `capture-${index}.png`);
    return req;
  };
  return { send, nonce };
}
beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  await migrateDatabase(pool);
  await redis.connect();
  app = createApp(pool, redis, config, engine);
  passwordHash = await argon2.hash('test-password-123');
  image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#c0a080' } })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await pool.end();
  if (redis.isOpen) await redis.quit();
  await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await adminPool.end();
});
beforeEach(async () => {
  observation = {
    embedding,
    model_version: 'fixture-model',
    quality_score: 0.99,
    liveness_score: 0.99,
  };
  workerError = false;
  workerHook = undefined;
  // Only the randomly created test database is reset. Existing databases and Redis keys are preserved.
  await pool.query('TRUNCATE users CASCADE');
  await pool.query(`UPDATE offices SET latitude=3.5,longitude=CASE code WHEN 'DISKOMINFO_PROVSU' THEN 98.6 WHEN 'KPID_SUMUT' THEN 98.61 ELSE 98.62 END,
    max_gps_accuracy_m=15,max_location_age_s=30,active=true,polygon=ST_Buffer(ST_SetSRID(ST_MakePoint(CASE code WHEN 'DISKOMINFO_PROVSU' THEN 98.6 WHEN 'KPID_SUMUT' THEN 98.61 ELSE 98.62 END,3.5),4326)::geography,50,'quad_segs=64')::geometry`);
  offices = Object.fromEntries(
    (await pool.query('SELECT id,code FROM offices')).rows.map((o) => [o.code, o.id]),
  );
  const users = await pool.query(
    `INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code) VALUES
    ('U1','Pegawai KPID','pegawai@example.test',$1,'EMPLOYEE','KPID'),('A1','Admin','admin@example.test',$1,'SUPER_ADMIN',NULL) RETURNING id,role`,
    [passwordHash],
  );
  user = users.rows.find((u) => u.role === 'EMPLOYEE').id;
  admin = users.rows.find((u) => u.role === 'SUPER_ADMIN').id;
  // Independent identities avoid cross-test login limiter state without clearing Redis.
  const email = `${randomUUID()}@example.test`;
  const adminEmail = `${randomUUID()}@example.test`;
  await pool.query('UPDATE users SET email=$2 WHERE id=$1', [user, email]);
  await pool.query('UPDATE users SET email=$2 WHERE id=$1', [admin, adminEmail]);
  const userLogin = await login(email),
    adminLogin = await login(adminEmail);
  expect(userLogin.status, userLogin.text).toBe(200);
  expect(adminLogin.status, adminLogin.text).toBe(200);
  access = userLogin.body.data.access_token;
  adminAccess = adminLogin.body.data.access_token;
  device = (
    await pool.query(
      "INSERT INTO devices(user_id,public_key,platform,status) VALUES($1,$2,'ANDROID','ACTIVE') RETURNING id",
      [user, publicKey],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO work_schedules(user_id,work_date,starts_at,ends_at) VALUES($1,(now() AT TIME ZONE 'Asia/Jakarta')::date,
    date_trunc('day',now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta',
    (date_trunc('day',now() AT TIME ZONE 'Asia/Jakarta')+interval '23 hours 59 minutes') AT TIME ZONE 'Asia/Jakarta')`,
    [user],
  );
  await pool.query(
    "INSERT INTO face_templates(user_id,encrypted_embedding,model_version,quality_score,consent_version,status,approved_by) VALUES($1,$2,'fixture-model',1,'test','ACTIVE',$3)",
    [user, encrypt(embedding, config.BIOMETRIC_KEY_BASE64, user), admin],
  );
});
describe('live database location rules', () => {
  for (const [category, code, longitude, allowed] of [
    ['KPID', 'DISKOMINFO_PROVSU', 98.6, true],
    ['KPID', 'KPID_SUMUT', 98.61, true],
    ['KPID', 'KI_SUMUT', 98.62, false],
    ['KI', 'DISKOMINFO_PROVSU', 98.6, true],
    ['KI', 'KI_SUMUT', 98.62, true],
    ['KI', 'KPID_SUMUT', 98.61, false],
  ] as const)
    it(`${category} at ${code}: ${allowed ? 'allow' : 'deny'}`, async () => {
      const result = selectOffice(
        pool,
        category,
        {
          latitude: 3.5,
          longitude,
          accuracy_m: 5,
          captured_at: new Date().toISOString(),
          office_id: offices[code],
        },
        new Date(),
      );
      if (allowed) expect((await result).code).toBe(code);
      else await expect(result).rejects.toMatchObject({ code: 'OFFICE_NOT_ALLOWED' });
    });
  it('enforces geodesic 50m boundaries from the original office coordinates in all directions', async () => {
    for (const bearing of [0, 90, 180, 270]) {
      for (const distance of [49.75, 49.99, 50.01, 50.2]) {
        const point = (
          await pool.query(
            'SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lng FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography,$2::float8,$3::float8) AS p FROM offices WHERE id=$1) q',
            [offices.DISKOMINFO_PROVSU, distance, (bearing * Math.PI) / 180],
          )
        ).rows[0];
        const result = selectOffice(
          pool,
          'KPID',
          {
            latitude: point.lat,
            longitude: point.lng,
            accuracy_m: 5,
            captured_at: new Date().toISOString(),
            office_id: offices.DISKOMINFO_PROVSU,
          },
          new Date(),
        );
        if (distance < 50) expect((await result).distance_m).toBeCloseTo(distance, 4);
        else await expect(result).rejects.toMatchObject({ code: 'GEOFENCE_OUT_OF_RANGE' });
      }
    }
  });
  it('enforces custom polygon geofencing boundaries', async () => {
    const poly = [
      { latitude: 3.58, longitude: 98.67 },
      { latitude: 3.59, longitude: 98.67 },
      { latitude: 3.59, longitude: 98.68 },
      { latitude: 3.58, longitude: 98.68 },
    ];
    await request(app)
      .patch(`/api/v1/admin/offices/${offices.DISKOMINFO_PROVSU}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ polygon: poly, latitude: 3.585, longitude: 98.675 });

    const inside = await selectOffice(
      pool,
      'KPID',
      {
        latitude: 3.585,
        longitude: 98.675,
        accuracy_m: 5,
        captured_at: new Date().toISOString(),
        office_id: offices.DISKOMINFO_PROVSU,
      },
      new Date(),
    );
    expect(inside.distance_m).toBe(0);

    await expect(
      selectOffice(
        pool,
        'KPID',
        {
          latitude: 3.57,
          longitude: 98.675,
          accuracy_m: 5,
          captured_at: new Date().toISOString(),
          office_id: offices.DISKOMINFO_PROVSU,
        },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'GEOFENCE_OUT_OF_RANGE' });
  });
  it('generates a valid 50m polygon from the configured office center', async () => {
    const updated = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KPID_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ latitude: 3.51, longitude: 98.63, radius_m: 50 });
    expect(updated.status, updated.text).toBe(200);
    const office = (
      await pool.query(
        'SELECT ST_IsValid(polygon) AS valid,ST_Covers(polygon,ST_SetSRID(ST_MakePoint(longitude,latitude),4326)) AS covers_center,radius_m FROM offices WHERE id=$1',
        [offices.KPID_SUMUT],
      )
    ).rows[0];
    expect(office).toEqual({ valid: true, covers_center: true, radius_m: 50 });
    const rejected = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KPID_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ radius_m: 500 });
    expect(rejected.status).toBe(400);
  });
  it('preserves excluded GeoJSON interiors and rejects self-intersecting polygons', async () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [98.5998, 3.4998],
          [98.6002, 3.4998],
          [98.6002, 3.5002],
          [98.5998, 3.5002],
          [98.5998, 3.4998],
        ],
        [
          [98.59995, 3.49995],
          [98.59995, 3.50005],
          [98.60005, 3.50005],
          [98.60005, 3.49995],
          [98.59995, 3.49995],
        ],
      ],
    };
    const updated = await request(app)
      .patch(`/api/v1/admin/offices/${offices.DISKOMINFO_PROVSU}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ polygon });
    expect(updated.status, updated.text).toBe(200);
    await expect(
      selectOffice(
        pool,
        'KPID',
        {
          latitude: 3.5,
          longitude: 98.6,
          accuracy_m: 5,
          captured_at: new Date().toISOString(),
          office_id: offices.DISKOMINFO_PROVSU,
        },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'GEOFENCE_OUT_OF_RANGE' });
    const invalid = await request(app)
      .patch(`/api/v1/admin/offices/${offices.DISKOMINFO_PROVSU}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({
        polygon: [
          { latitude: 3.4998, longitude: 98.5998 },
          { latitude: 3.5002, longitude: 98.6002 },
          { latitude: 3.5002, longitude: 98.5998 },
          { latitude: 3.4998, longitude: 98.6002 },
        ],
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('POLYGON_INVALID');
  });
  it('rejects inaccurate, stale, inactive and uncategorized locations', async () => {
    const base = {
      latitude: 3.5,
      longitude: 98.6,
      accuracy_m: 5,
      captured_at: new Date().toISOString(),
      office_id: offices.DISKOMINFO_PROVSU,
    };
    await expect(
      selectOffice(pool, 'KPID', { ...base, accuracy_m: 20 }, new Date()),
    ).rejects.toMatchObject({ code: 'GPS_ACCURACY_LOW' });
    await expect(
      selectOffice(
        pool,
        'KPID',
        { ...base, captured_at: new Date(Date.now() - 60000).toISOString() },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'LOCATION_STALE' });
    await expect(selectOffice(pool, null, base, new Date())).rejects.toMatchObject({
      code: 'EMPLOYEE_CATEGORY_INVALID',
    });
    await pool.query('UPDATE offices SET active=false WHERE id=$1', [offices.DISKOMINFO_PROVSU]);
    await expect(selectOffice(pool, 'KPID', base, new Date())).rejects.toMatchObject({
      code: 'OFFICE_UNAVAILABLE',
    });
  });
});
describe('API security and attendance', () => {
  it('requires authentication and enforces admin authorization', async () => {
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/admin/users').auth(access, { type: 'bearer' })).status,
    ).toBe(403);
  });
  it('reads the current category even with an existing access token', async () => {
    let officesResult = await request(app).get('/api/v1/offices').auth(access, { type: 'bearer' });
    expect(officesResult.body.data.map((o: { code: string }) => o.code)).toEqual([
      'DISKOMINFO_PROVSU',
      'KPID_SUMUT',
    ]);
    const updated = await request(app)
      .patch(`/api/v1/admin/users/${user}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ employee_category_code: 'KI' });
    expect(updated.status, updated.text).toBe(200);
    officesResult = await request(app).get('/api/v1/offices').auth(access, { type: 'bearer' });
    expect(officesResult.body.data.map((o: { code: string }) => o.code)).toEqual([
      'DISKOMINFO_PROVSU',
      'KI_SUMUT',
    ]);
  });
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    const original = (await login(email)).body.data;
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: original.refresh_token });
    expect(rotated.status).toBe(200);
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: original.refresh_token });
    expect(replay.status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/v1/me')
          .auth(rotated.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(401);
  });
  it('revokes access immediately on logout', async () => {
    expect(
      (await request(app).post('/api/v1/auth/logout').auth(access, { type: 'bearer' })).status,
    ).toBe(204);
    expect((await request(app).get('/api/v1/me').auth(access, { type: 'bearer' })).status).toBe(
      401,
    );
  });
  it('records one attendance and returns its saved result for an identical retry', async () => {
    const attempt = await capture();
    const first = await attempt.send();
    expect(first.status, first.text).toBe(201);
    const repeated = await attempt.send();
    expect(repeated.status, repeated.text).toBe(201);
    expect(repeated.body.data.id).toBe(first.body.data.id);
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(1);
  });
  it('handles simultaneous retries and prevents a second accepted check-in', async () => {
    const first = await capture(),
      second = await capture();
    const results = await Promise.all([first.send(), first.send(), second.send()]);
    expect(
      results.some((r) => r.status === 201),
      results.map((r) => r.text).join('\n'),
    ).toBe(true);
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(1);
    expect(results.every((r) => [201, 202, 409].includes(r.status))).toBe(true);
  });
  it('rejects changed payloads with the same idempotency key', async () => {
    const attempt = await capture();
    expect((await attempt.send()).status).toBe(201);
    const changed = await capture(
      'CHECK_IN',
      { accuracy_m: '6' },
      attempt.key,
      attempt.fields.nonce,
    );
    expect((await changed.send()).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('rejects a consumed nonce with a new idempotency key', async () => {
    const attempt = await capture();
    expect((await attempt.send()).status).toBe(201);
    const replay = await capture('CHECK_IN', {}, randomUUID(), attempt.fields.nonce);
    expect((await replay.send()).body.error.code).toBe('REPLAY_DETECTED');
  });
  it('rejects tampered signatures before inference', async () => {
    const attempt = await capture();
    let req = request(app)
      .post('/api/v1/attendance/check-in')
      .auth(access, { type: 'bearer' })
      .set('Idempotency-Key', attempt.key);
    for (const [key, value] of Object.entries({
      ...attempt.fields,
      signature: Buffer.alloc(64).toString('base64'),
    }))
      req = req.field(key, value);
    const result = await req.attach('image', image, 'photo.png');
    expect(result.body.error.code).toBe('DEVICE_SIGNATURE_INVALID');
  });
  for (const purpose of ['CHECK_IN', 'CHECK_OUT'] as const)
    it(`${purpose} rejects a forbidden office before face inference`, async () => {
      const result = await (
        await capture(purpose, { office_id: offices.KI_SUMUT!, longitude: '98.62' })
      ).send();
      expect(result.status, result.text).toBe(403);
      expect(result.body.error.code).toBe('OFFICE_NOT_ALLOWED');
      expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(0);
    });
  it('requires a check-in and allows check-out at another permitted office', async () => {
    let result = await (await capture('CHECK_OUT')).send();
    expect(result.body.error.code).toBe('CHECK_IN_REQUIRED');
    expect((await (await capture()).send()).status).toBe(201);
    result = await (
      await capture('CHECK_OUT', { office_id: offices.KPID_SUMUT!, longitude: '98.61' })
    ).send();
    expect(result.status, result.text).toBe(201);
    expect(result.body.data.office_id).toBe(offices.KPID_SUMUT);
    result = await (await capture('CHECK_OUT')).send();
    expect(result.body.error.code).toBe('DUPLICATE_ATTENDANCE');
  });
  it('fails closed when the face worker is down', async () => {
    workerError = true;
    const result = await (await capture()).send();
    expect(result.status, result.text).toBe(503);
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM attendance_attempts')).rows[0].status).toBe(
      'ERROR',
    );
  });
  it('rejects failed liveness and records the attempt', async () => {
    observation = { ...observation, liveness_score: 0.1 };
    const result = await (await capture()).send();
    expect(result.body.error.code).toBe('LIVENESS_FAILED');
    expect((await pool.query('SELECT status FROM attendance_attempts')).rows[0].status).toBe(
      'REJECTED',
    );
  });
  it('does not record gray-zone matches as attendance', async () => {
    observation = {
      ...observation,
      embedding: embedding.map((_, i) => (i === 0 ? 0.7 : i === 1 ? Math.sqrt(0.51) : 0)),
    };
    const result = await (await capture()).send();
    expect(result.status, result.text).toBe(202);
    expect(result.body.data.status).toBe('NEEDS_REVIEW');
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(0);
  });
  it('rechecks category changes made during inference', async () => {
    workerHook = async () => {
      await pool.query("UPDATE users SET employee_category_code='KI' WHERE id=$1", [user]);
    };
    const result = await (
      await capture('CHECK_IN', { office_id: offices.KPID_SUMUT!, longitude: '98.61' })
    ).send();
    expect(result.body.error.code).toBe('OFFICE_NOT_ALLOWED');
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(0);
  });
  it('preserves historical snapshots when category and location change', async () => {
    expect((await (await capture()).send()).status).toBe(201);
    await pool.query("UPDATE users SET employee_category_code='KI' WHERE id=$1", [user]);
    await pool.query("UPDATE offices SET name='Changed office' WHERE id=$1", [
      offices.DISKOMINFO_PROVSU,
    ]);
    const row = (
      await pool.query('SELECT employee_category_at_event,office_snapshot FROM attendances')
    ).rows[0];
    expect(row.employee_category_at_event).toBe('KPID');
    expect(row.office_snapshot.name).not.toBe('Changed office');
  });
  it('rejects arbitrary category fields supplied in an attendance request', async () => {
    const attempt = await capture();
    let req = request(app)
      .post('/api/v1/attendance/check-in')
      .auth(access, { type: 'bearer' })
      .set('Idempotency-Key', attempt.key);
    for (const [key, value] of Object.entries({
      ...attempt.fields,
      signature: 'x'.repeat(64),
      employee_category: 'KI',
    }))
      req = req.field(key, value);
    expect((await req.attach('image', image, 'photo.png')).status).toBe(400);
  });
  it('prevents an office from becoming active without coordinates', async () => {
    await pool.query('UPDATE offices SET active=false,latitude=NULL,longitude=NULL WHERE id=$1', [
      offices.KI_SUMUT,
    ]);
    const result = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KI_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ active: true });
    expect(result.body.error.code).toBe('OFFICE_NOT_CONFIGURED');
  });
  it('configures and validates polygon geofencing at API and database layers', async () => {
    const invalid = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KI_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({
        polygon: [
          { latitude: 3.5, longitude: 98.6 },
          { latitude: 3.51, longitude: 98.61 },
        ],
      });
    expect(invalid.status).toBe(400);

    const valid = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KI_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({
        polygon: [
          { latitude: 3.58, longitude: 98.67 },
          { latitude: 3.585, longitude: 98.67 },
          { latitude: 3.585, longitude: 98.675 },
          { latitude: 3.58, longitude: 98.675 },
        ],
      });
    expect(valid.status).toBe(200);
    const dbOffice = (
      await pool.query('SELECT polygon IS NOT NULL AS has_polygon FROM offices WHERE id=$1', [
        offices.KI_SUMUT,
      ])
    ).rows[0];
    expect(dbOffice.has_polygon).toBe(true);
  });
  it('prevents audit updates and does not expose biometric templates', async () => {
    expect((await (await capture()).send()).status).toBe(201);
    await expect(pool.query("UPDATE audit_logs SET action='changed'")).rejects.toThrow(
      'append-only',
    );
    const me = await request(app).get('/api/v1/me').auth(access, { type: 'bearer' });
    expect(me.text).not.toContain('encrypted_embedding');
    expect(me.text).not.toContain('password_hash');
  });
});

describe('device and enrollment approvals', () => {
  it('keeps the old device active until another admin approves its replacement', async () => {
    const signature = sign(
      null,
      Buffer.from(`bind:${user}:ANDROID:${hash(publicKey)}`),
      pair.privateKey,
    ).toString('base64');
    const pending = await request(app)
      .post('/api/v1/devices/bind')
      .auth(access, { type: 'bearer' })
      .send({ public_key: publicKey, platform: 'ANDROID', signature });
    expect(pending.status, pending.text).toBe(201);
    expect(pending.body.data.status).toBe('PENDING');
    expect(
      (await pool.query("SELECT id FROM devices WHERE user_id=$1 AND status='ACTIVE'", [user]))
        .rows[0].id,
    ).toBe(device);
    const approved = await request(app)
      .patch(`/api/v1/admin/devices/${pending.body.data.id}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ status: 'ACTIVE', reason: 'Perangkat pengganti telah diperiksa' });
    expect(approved.status, approved.text).toBe(200);
    expect(
      (
        await pool.query("SELECT id FROM devices WHERE user_id=$1 AND status='ACTIVE'", [user])
      ).rows.map((d) => d.id),
    ).toEqual([pending.body.data.id]);
    expect(
      (
        await request(app)
          .post('/api/v1/attendance/challenges')
          .auth(access, { type: 'bearer' })
          .send({ device_id: device, purpose: 'CHECK_IN' })
      ).body.error.code,
    ).toBe('DEVICE_NOT_BOUND');
  });
  it('prevents self approval even for a super admin', async () => {
    const own = (
      await pool.query(
        "INSERT INTO devices(user_id,public_key,platform) VALUES($1,$2,'ANDROID') RETURNING id",
        [admin, publicKey],
      )
    ).rows[0].id;
    const result = await request(app)
      .patch(`/api/v1/admin/devices/${own}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ status: 'ACTIVE', reason: 'Pengujian persetujuan sendiri' });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });
  it('accepts only the Android platform', async () => {
    const result = await request(app)
      .post('/api/v1/devices/bind')
      .auth(access, { type: 'bearer' })
      .send({ public_key: publicKey, platform: 'IOS', signature: 'x' });
    expect(result.status).toBe(400);
  });
  it('requires approved enrollment before attendance, then accepts the approved template', async () => {
    await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
    const nonce = await challenge('ENROLL');
    const images = await Promise.all(
      ['#c0a081', '#c0a082', '#c0a083'].map((background) =>
        sharp({ create: { width: 128, height: 128, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const signature = sign(
      null,
      Buffer.from(`enroll:${user}:${device}:${nonce}:pilot-v1:${images.map(hash).join(':')}`),
      pair.privateKey,
    ).toString('base64');
    let req = request(app)
      .post('/api/v1/face/enroll')
      .auth(access, { type: 'bearer' })
      .field('device_id', device)
      .field('nonce', nonce)
      .field('consent', 'true')
      .field('consent_version', 'pilot-v1')
      .field('signature', signature);
    for (const [index, photo] of images.entries())
      req = req.attach('images', photo, `capture-${index}.png`);
    const enrolled = await req;
    expect(enrolled.status, enrolled.text).toBe(201);
    expect(enrolled.body.data.status).toBe('PENDING');
    expect((await (await capture()).send()).body.error.code).toBe('FACE_NOT_ENROLLED');
    const rejected = await request(app)
      .patch(`/api/v1/admin/face-enrollments/${enrolled.body.data.id}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({
        status: 'ACTIVE',
        identity_verified: false,
        reason: 'Belum ada pemeriksaan identitas',
      });
    expect(rejected.body.error.code).toBe('IDENTITY_VERIFICATION_REQUIRED');
    const approved = await request(app)
      .patch(`/api/v1/admin/face-enrollments/${enrolled.body.data.id}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({
        status: 'ACTIVE',
        identity_verified: true,
        reason: 'Identitas pegawai diverifikasi petugas',
      });
    expect(approved.status, approved.text).toBe(204);
    expect((await (await capture()).send()).status).toBe(201);
  });
  it('deletes biometric templates without deleting attendance history', async () => {
    expect((await (await capture()).send()).status).toBe(201);
    const result = await request(app)
      .delete(`/api/v1/admin/users/${user}/face`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ reason: 'Permintaan reset biometrik pegawai' });
    expect(result.status, result.text).toBe(204);
    expect(
      (await pool.query('SELECT id FROM face_templates WHERE user_id=$1', [user])).rowCount,
    ).toBe(0);
    expect((await pool.query('SELECT id FROM attendances WHERE user_id=$1', [user])).rowCount).toBe(
      1,
    );
  });

  it('invalidates an enrollment in progress when an admin resets face data, even with no saved template', async () => {
    await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
    const pending = await enrollment();
    let reset = false;
    workerHook = async () => {
      if (reset) return;
      reset = true;
      const result = await request(app)
        .delete(`/api/v1/admin/users/${user}/face`)
        .auth(adminAccess, { type: 'bearer' })
        .send({ reason: 'Reset during pending inference' });
      expect(result.status, result.text).toBe(204);
    };
    const response = await pending.send();
    expect(response.status, response.text).toBe(409);
    expect(response.body.error.code).toBe('FACE_ENROLLMENT_CHANGED');
    expect(
      (await pool.query('SELECT id FROM face_templates WHERE user_id=$1', [user])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT face_enrollment_version FROM users WHERE id=$1', [user])).rows[0]
        .face_enrollment_version,
    ).toBe(1);
    workerHook = undefined;
    expect((await (await enrollment()).send()).status).toBe(201);
  });

  it('accepts only one of two enrollments that start before either template is saved', async () => {
    await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
    const first = await enrollment(),
      second = await enrollment();
    let arrived = 0,
      release!: () => void,
      bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    workerHook = async () => {
      arrived++;
      if (arrived <= 2) {
        if (arrived === 2) bothStarted();
        await gate;
      }
    };
    const requests = [first.send().then((r) => r), second.send().then((r) => r)];
    await started;
    release();
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe(
      'FACE_ENROLLMENT_CHANGED',
    );
    expect(
      (await pool.query('SELECT status FROM face_templates WHERE user_id=$1', [user])).rows,
    ).toEqual([{ status: 'PENDING' }]);
  });

  it('does not create another pending template if a concurrent enrollment was approved during inference', async () => {
    await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
    const slow = await enrollment();
    let release!: () => void, inferenceStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    workerHook = async (nonce) => {
      if (nonce === slow.nonce) {
        inferenceStarted();
        await gate;
      }
    };
    const slowResponse = slow.send().then((r) => r);
    await started;
    try {
      const fast = await (await enrollment()).send();
      expect(fast.status, fast.text).toBe(201);
      const approved = await request(app)
        .patch(`/api/v1/admin/face-enrollments/${fast.body.data.id}`)
        .auth(adminAccess, { type: 'bearer' })
        .send({
          status: 'ACTIVE',
          identity_verified: true,
          reason: 'Verify concurrent enrollment',
        });
      expect(approved.status, approved.text).toBe(204);
    } finally {
      release();
    }
    const response = await slowResponse;
    expect(response.status, response.text).toBe(409);
    expect(response.body.error.code).toBe('FACE_ENROLLMENT_CHANGED');
    expect(
      (await pool.query('SELECT status FROM face_templates WHERE user_id=$1', [user])).rows,
    ).toEqual([{ status: 'ACTIVE' }]);
  });

  it.each(['ACTIVE', 'PENDING'])(
    'rechecks a template inserted by another writer during inference: %s',
    async (status) => {
      await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
      const pending = await enrollment();
      let inserted = false;
      workerHook = async () => {
        if (inserted) return;
        inserted = true;
        await pool.query(
          "INSERT INTO face_templates(user_id,encrypted_embedding,model_version,quality_score,consent_version,status) VALUES($1,$2,'fixture-model',1,'test',$3)",
          [user, encrypt(embedding, config.BIOMETRIC_KEY_BASE64, user), status],
        );
      };
      const result = await pending.send();
      expect(result.status, result.text).toBe(409);
      expect(result.body.error.code).toBe('FACE_ALREADY_ENROLLED');
      expect(
        (await pool.query('SELECT status FROM face_templates WHERE user_id=$1', [user])).rows,
      ).toEqual([{ status }]);
    },
  );

  it.each(['USER_INACTIVE', 'DEVICE_NOT_BOUND'])(
    'rechecks %s before storing an enrollment',
    async (code) => {
      await pool.query('DELETE FROM face_templates WHERE user_id=$1', [user]);
      const pending = await enrollment();
      workerHook = async () => {
        if (code === 'USER_INACTIVE')
          await pool.query('UPDATE users SET active=false WHERE id=$1', [user]);
        else await pool.query("UPDATE devices SET status='REVOKED' WHERE id=$1", [device]);
      };
      const result = await pending.send();
      expect(result.status, result.text).toBe(403);
      expect(result.body.error.code).toBe(code);
      expect(
        (await pool.query('SELECT id FROM face_templates WHERE user_id=$1', [user])).rowCount,
      ).toBe(0);
    },
  );

  it('rejects overnight schedules at the API and database while accepting equivalent UTC timestamps', async () => {
    const schedule = {
      user_id: user,
      work_date: '2035-01-01',
      starts_at: '2035-01-01T22:00:00+07:00',
      ends_at: '2035-01-02T06:00:00+07:00',
    };
    const response = await request(app)
      .post('/api/v1/admin/schedules')
      .auth(adminAccess, { type: 'bearer' })
      .send(schedule);
    expect(response.status, response.text).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    await expect(
      pool.query(
        'INSERT INTO work_schedules(user_id,work_date,starts_at,ends_at) VALUES($1,$2,$3,$4)',
        [user, schedule.work_date, schedule.starts_at, schedule.ends_at],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'work_schedules_same_day' });
    const accepted = await request(app)
      .post('/api/v1/admin/schedules')
      .auth(adminAccess, { type: 'bearer' })
      .send({ ...schedule, starts_at: '2034-12-31T17:00:00Z', ends_at: '2035-01-01T16:59:59Z' });
    expect(accepted.status, accepted.text).toBe(201);
  });
  it('rechecks device revocation during inference', async () => {
    workerHook = async () => {
      await pool.query("UPDATE devices SET status='REVOKED' WHERE id=$1", [device]);
    };
    const result = await (await capture()).send();
    expect(result.body.error.code).toBe('DEVICE_NOT_BOUND');
    expect((await pool.query('SELECT id FROM attendances')).rowCount).toBe(0);
  });
  it('prevents a category admin from promoting users or changing their category', async () => {
    const email = `${randomUUID()}@example.test`;
    const created = await request(app)
      .post('/api/v1/admin/users')
      .auth(adminAccess, { type: 'bearer' })
      .send({
        employee_number: 'CATEGORY-ADMIN',
        name: 'Admin KPID',
        email,
        password: 'test-password-123',
        employee_category_code: 'KPID',
        role: 'ADMIN',
      });
    expect(created.status, created.text).toBe(201);
    const access = (await login(email)).body.data.access_token;
    for (const change of [{ role: 'SUPER_ADMIN' }, { employee_category_code: 'KI' }]) {
      expect(
        (
          await request(app)
            .patch(`/api/v1/admin/users/${user}`)
            .auth(access, { type: 'bearer' })
            .send(change)
        ).status,
      ).toBe(403);
    }
  });
});

describe('internal login hardening', () => {
  it('reports an occupied HTTP port without logging a successful startup', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, resolve));
    const port = (occupied.address() as import('node:net').AddressInfo).port;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(config)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        new Promise<number | null>((resolve, reject) => {
          child.on('close', resolve);
          child.on('error', reject);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Server did not exit on port conflict: ' + output)),
            8000,
          );
        }),
      ]);
      expect(code).toBe(1);
      expect(output).toContain('EADDRINUSE');
      expect(output).not.toContain('Absensi API started');
      expect(output).not.toContain(config.JWT_SECRET);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it('returns the same login failure for unknown, disabled, SSO-only and wrong-password accounts', async () => {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    const call = (email: string) =>
      request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-value' });
    const unknown = await call(`${randomUUID()}@example.test`),
      wrong = await call(email);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [user]);
    const inactive = await call(email);
    await pool.query("UPDATE users SET active=true,auth_mode='SSO' WHERE id=$1", [user]);
    const sso = await call(email);
    for (const result of [unknown, wrong, inactive, sso]) {
      expect(result.status, result.text).toBe(401);
      expect(result.body.error).toEqual(unknown.body.error);
    }
  });
  it('limits failed account logins across different client IPs', async () => {
    const scoped = createApp(pool, redis, { ...config, TRUST_PROXY: '127.0.0.1,::1' }, engine);
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    for (let i = 0; i < 11; i++) {
      const result = await request(scoped)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `192.0.2.${i + 1}`)
        .send({ email, password: 'incorrect-password' });
      expect(result.status, result.text).toBe(i < 10 ? 401 : 429);
    }
  });
  it('does not count successful logins as failed account attempts', async () => {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    for (let i = 0; i < 12; i++) expect((await login(email)).status).toBe(200);
  });
  it('revokes all user sessions while leaving another user logged in', async () => {
    const second = await issueSession(pool, config, user, randomUUID());
    const response = await request(app)
      .post('/api/v1/auth/logout-all')
      .auth(access, { type: 'bearer' });
    expect(response.status, response.text).toBe(204);
    for (const value of [access, second.access_token])
      expect((await request(app).get('/api/v1/me').auth(value, { type: 'bearer' })).status).toBe(
        401,
      );
    expect(
      (await request(app).get('/api/v1/me').auth(adminAccess, { type: 'bearer' })).status,
    ).toBe(200);
  });
  it('changes the password and revokes access and refresh tokens in all sessions', async () => {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    const other = await issueSession(pool, config, user, randomUUID());
    const call = (current: string, next: string) =>
      request(app)
        .post('/api/v1/auth/change-password')
        .auth(access, { type: 'bearer' })
        .send({ current_password: current, new_password: next });
    expect((await call('incorrect-password', 'new-password-secure-456')).status).toBe(401);
    expect((await request(app).get('/api/v1/me').auth(access, { type: 'bearer' })).status).toBe(
      200,
    );
    const changed = await call('test-password-123', 'new-password-secure-456');
    expect(changed.status, changed.text).toBe(204);
    expect(
      (await request(app).get('/api/v1/me').auth(other.access_token, { type: 'bearer' })).status,
    ).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: other.refresh_token }))
        .status,
    ).toBe(401);
    expect((await login(email)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email, password: 'new-password-secure-456' })
      ).status,
    ).toBe(200);
    const saved = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [user])).rows[0]
      .password_hash;
    expect(saved).toMatch(/^\$argon2id\$/);
    expect(saved).not.toContain('new-password-secure-456');
  });
  it('rejects weak new passwords and requests without authentication', async () => {
    expect(
      (
        await request(app)
          .post('/api/v1/auth/change-password')
          .send({ current_password: 'test-password-123', new_password: 'new-password-secure-456' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/change-password')
          .auth(access, { type: 'bearer' })
          .send({ current_password: 'test-password-123', new_password: 'short' })
      ).status,
    ).toBe(400);
  });
  it('does not save plaintext refresh tokens and rejects expired refresh sessions', async () => {
    const session = await issueSession(pool, config, user, randomUUID());
    const row = (
      await pool.query('SELECT token_hash FROM refresh_sessions WHERE token_hash=$1', [
        hash(session.refresh_token),
      ])
    ).rows[0];
    expect(row.token_hash).not.toBe(session.refresh_token);
    await pool.query('UPDATE refresh_sessions SET expires_at=$2 WHERE token_hash=$1', [
      row.token_hash,
      new Date(Date.now() - 60000),
    ]);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refresh_token: session.refresh_token })
      ).status,
    ).toBe(401);
  });
  it('provides auth readiness without an available biometric worker or Google credentials', async () => {
    const scoped = createApp(pool, redis, config, {
      ready: async () => false,
      observe: engine.observe,
    });
    expect((await request(scoped).get('/ready/auth')).status).toBe(200);
    expect((await request(scoped).get('/ready')).status).toBe(503);
    const methods = await request(scoped).get('/api/v1/auth/methods');
    expect(methods.body.data).toMatchObject({ local: true, sso: false });
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/sso/start')
          .send({ code_challenge: 'x'.repeat(43) })
      ).body.error.code,
    ).toBe('SSO_NOT_CONFIGURED');
  });
  it('fails readiness and rejects requests while Redis is unavailable, then recovers', async () => {
    const isolatedRedis = createRedisClient(config.REDIS_URL);
    isolatedRedis.on('error', () => {});
    try {
      await isolatedRedis.connect();
      const scoped = createApp(pool, isolatedRedis, config, engine);
      // Let each RedisStore finish loading its scripts before simulating an outage.
      expect((await request(scoped).post('/api/v1/auth/login').send({})).status).toBe(400);
      isolatedRedis.destroy();
      const ready = await request(scoped).get('/ready/auth');
      expect(ready.status).toBe(503);
      expect(ready.body.data.redis).toBe(false);
      const login = await request(scoped).post('/api/v1/auth/login').send({});
      expect(login.status).toBe(503);
      expect(login.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
      await isolatedRedis.connect();
      expect((await request(scoped).get('/ready/auth')).status).toBe(200);
      expect((await request(scoped).post('/api/v1/auth/login').send({})).status).toBe(400);
    } finally {
      if (isolatedRedis.isOpen) isolatedRedis.destroy();
    }
  });
  it('keeps login, admin and auth readiness available without biometric secrets', async () => {
    const authConfig = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: config.DATABASE_URL,
      REDIS_URL: config.REDIS_URL,
      JWT_SECRET: config.JWT_SECRET,
      SSO_ENABLED: 'false',
    });
    const scoped = createApp(pool, redis, authConfig);
    expect((await request(scoped).get('/health')).status).toBe(200);
    expect((await request(scoped).get('/ready/auth')).status).toBe(200);
    const readiness = await request(scoped).get('/ready');
    expect(readiness.status).toBe(503);
    expect(readiness.body.data).toMatchObject({
      database: true,
      redis: true,
      face_worker: false,
      notification_worker: false,
    });
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [admin])).rows[0].email;
    const session = await request(scoped)
      .post('/api/v1/auth/login')
      .send({ email, password: 'test-password-123' });
    expect(session.status, session.text).toBe(200);
    expect(
      (
        await request(scoped)
          .get('/api/v1/admin/users')
          .auth(session.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(200);
  });
  it('evaluates notification worker readiness in /ready when FCM is enabled', async () => {
    let notifReady = false;
    const fcmConfig = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: config.DATABASE_URL,
      REDIS_URL: config.REDIS_URL,
      JWT_SECRET: config.JWT_SECRET,
      SSO_ENABLED: 'false',
      FCM_ENABLED: 'true',
    });
    const scoped = createApp(
      pool,
      redis,
      fcmConfig,
      {
        ready: async () => true,
        observe: async () => observation,
      },
      undefined,
      undefined,
      async () => notifReady,
    );
    const down = await request(scoped).get('/ready');
    expect(down.status).toBe(503);
    expect(down.body.data).toMatchObject({
      database: true,
      redis: true,
      face_worker: true,
      notification_worker: false,
    });

    notifReady = true;
    const up = await request(scoped).get('/ready');
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({
      database: true,
      redis: true,
      face_worker: true,
      notification_worker: true,
    });
  });
  it('rejects enrollment and both attendance operations without the encryption key', async () => {
    let observations = 0;
    const scoped = createApp(
      pool,
      redis,
      { ...config, BIOMETRIC_KEY_BASE64: '' },
      {
        ready: async () => true,
        observe: async () => {
          observations++;
          return observation;
        },
      },
    );
    const enrollment = await request(scoped)
      .post('/api/v1/face/enroll')
      .auth(access, { type: 'bearer' })
      .field('device_id', device)
      .field('nonce', 'n'.repeat(40))
      .field('signature', 's'.repeat(64))
      .field('consent_version', 'test')
      .field('consent', 'true')
      .attach('images', image, 'selfie.png');
    expect(enrollment.status, enrollment.text).toBe(503);
    expect(enrollment.body.error.code).toBe('FACE_NOT_CONFIGURED');
    for (const purpose of ['check-in', 'check-out']) {
      const result = await request(scoped)
        .post(`/api/v1/attendance/${purpose}`)
        .auth(access, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .field('device_id', device)
        .field('nonce', 'n'.repeat(40))
        .field('signature', 's'.repeat(64))
        .field('latitude', '3.5')
        .field('longitude', '98.6')
        .field('accuracy_m', '5')
        .field('captured_at', new Date().toISOString())
        .field('is_mock', 'false')
        .attach('image', image, 'selfie.png');
      expect(result.status, result.text).toBe(503);
      expect(result.body.error.code).toBe('FACE_NOT_CONFIGURED');
    }
    expect(observations).toBe(0);
    expect((await pool.query('SELECT * FROM attendances')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM face_templates')).rowCount).toBe(1);
  });
  it('requires HTTPS in production and trusts forwarded protocol only from configured proxies', async () => {
    const secured = createApp(pool, redis, { ...config, NODE_ENV: 'production' }, engine);
    const spoof = await request(secured)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: 'nobody@example.test', password: 'bad' });
    expect(spoof.body.error.code).toBe('HTTPS_REQUIRED');
    const trusted = createApp(
      pool,
      redis,
      { ...config, NODE_ENV: 'production', TRUST_PROXY: '127.0.0.1,::1' },
      engine,
    );
    const accepted = await request(trusted)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: `${randomUUID()}@example.test`, password: 'bad' });
    expect(accepted.status, accepted.text).toBe(401);
    expect(accepted.body.error.code).toBe('LOGIN_FAILED');
  });
  it('allows independent refreshes for more than ten sessions behind the same office IP', async () => {
    const tokens = [];
    for (let i = 0; i < 11; i++) tokens.push(await issueSession(pool, config, user, randomUUID()));
    for (const session of tokens) {
      const result = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: session.refresh_token });
      expect(result.status, result.text).toBe(200);
    }
  });
  it('does not extend the original session expiry when rotating a refresh token', async () => {
    const session = await issueSession(pool, config, user, randomUUID());
    const expiry = new Date(Date.now() + 300000);
    await pool.query('UPDATE refresh_sessions SET expires_at=$2 WHERE token_hash=$1', [
      hash(session.refresh_token),
      expiry,
    ]);
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: session.refresh_token });
    expect(rotated.status, rotated.text).toBe(200);
    const saved = (
      await pool.query('SELECT expires_at FROM refresh_sessions WHERE token_hash=$1', [
        hash(rotated.body.data.refresh_token),
      ])
    ).rows[0];
    expect(saved.expires_at.getTime()).toBe(expiry.getTime());
  });
  it('revokes a concurrently rotated child session when logout waits for its transaction', async () => {
    const family = randomUUID(),
      original = await issueSession(pool, config, user, family);
    const old = (
      await pool.query('SELECT id FROM refresh_sessions WHERE token_hash=$1', [
        hash(original.refresh_token),
      ])
    ).rows[0].id;
    const db = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.query('UPDATE refresh_sessions SET revoked_at=now() WHERE id=$1', [old]);
      await issueSession(db, config, user, family);
      pending = logoutUser(pool, old);
      void pending.catch(() => {});
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const blocked = await pool.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (blocked.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.query('COMMIT');
      await pending;
      expect(
        (
          await pool.query(
            'SELECT id FROM refresh_sessions WHERE family_id=$1 AND revoked_at IS NULL',
            [family],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query('ROLLBACK');
      db.release();
      if (pending) await pending;
    }
  });
});

describe('admin web integration', () => {
  const origin = 'https://admin.example.test';
  const webConfig = { ...config, WEB_AUTH_ENABLED: 'true' as const, ADMIN_WEB_ORIGIN: origin };
  const webApp = () => createApp(pool, redis, webConfig, engine);
  const cookie = (r: request.Response, name = 'absensi_web_refresh') => {
    const values = r.headers['set-cookie'] as unknown as string[];
    return values.find((v) => v.startsWith(name + '='))!.split(';')[0]!;
  };
  async function webLogin(scoped: ReturnType<typeof createApp>) {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [admin])).rows[0].email;
    const result = await request(scoped)
      .post('/api/v1/auth/web/login')
      .set('Origin', origin)
      .send({ email, password: 'test-password-123' });
    expect(result.status, result.text).toBe(200);
    return result;
  }
  it('keeps refresh tokens in HttpOnly cookies, rotates them, restores CSRF, and revokes replayed families', async () => {
    const scoped = webApp(),
      login = await webLogin(scoped),
      first = cookie(login);
    expect(login.body.data.refresh_token).toBeUndefined();
    expect(login.headers['set-cookie']![0]).toContain('HttpOnly');
    expect(login.headers['set-cookie']![0]).toContain('SameSite=Strict');
    const csrf = await request(scoped)
      .post('/api/v1/auth/web/session')
      .set('Origin', origin)
      .set('Cookie', first);
    expect(csrf.status).toBe(200);
    expect(csrf.body.data.csrf_token).toBe(login.body.data.csrf_token);
    const refreshed = await request(scoped)
      .post('/api/v1/auth/web/refresh')
      .set('Origin', origin)
      .set('Cookie', first)
      .set('X-CSRF-Token', csrf.body.data.csrf_token);
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(cookie(refreshed)).not.toBe(first);
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(login.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(401);
    const replay = await request(scoped)
      .post('/api/v1/auth/web/refresh')
      .set('Origin', origin)
      .set('Cookie', first)
      .set('X-CSRF-Token', csrf.body.data.csrf_token);
    expect(replay.status).toBe(401);
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(refreshed.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(401);
  });
  it('limits web sessions to eight hours without extending the absolute deadline on refresh', async () => {
    const scoped = webApp(),
      login = await webLogin(scoped),
      first = cookie(login),
      refresh = first.split('=')[1]!;
    const initial = (
      await pool.query('SELECT expires_at FROM refresh_sessions WHERE token_hash=$1', [
        hash(refresh),
      ])
    ).rows[0].expires_at as Date;
    expect(initial.getTime() - Date.now()).toBeGreaterThan(8 * 3600000 - 10000);
    expect(initial.getTime() - Date.now()).toBeLessThanOrEqual(8 * 3600000);
    const result = await request(scoped)
      .post('/api/v1/auth/web/refresh')
      .set('Origin', origin)
      .set('Cookie', first)
      .set('X-CSRF-Token', login.body.data.csrf_token);
    expect(result.status, result.text).toBe(200);
    const current = (
      await pool.query('SELECT expires_at FROM refresh_sessions WHERE token_hash=$1', [
        hash(cookie(result).split('=')[1]!),
      ])
    ).rows[0].expires_at as Date;
    expect(current.getTime()).toBe(initial.getTime());
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/session')
          .set('Origin', origin)
          .set('Cookie', first + '; ' + first)
      ).status,
    ).toBe(401);
  });
  it('rejects employees, untrusted origins, and missing or wrong CSRF tokens', async () => {
    const scoped = webApp();
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [user])).rows[0].email;
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/login')
          .set('Origin', origin)
          .send({ email, password: 'test-password-123' })
      ).status,
    ).toBe(403);
    const login = await webLogin(scoped);
    for (const headers of [
      { origin, csrf: '' },
      { origin, csrf: 'wrong' },
      { origin: 'https://evil.example', csrf: login.body.data.csrf_token },
    ]) {
      expect(
        (
          await request(scoped)
            .post('/api/v1/auth/web/refresh')
            .set('Origin', headers.origin)
            .set('Cookie', cookie(login))
            .set('X-CSRF-Token', headers.csrf)
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/session')
          .set('Origin', 'https://evil.example')
          .set('Cookie', cookie(login))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(login.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(200);
  });
  it('separates mobile and web refresh channels and logs out a web family', async () => {
    const scoped = webApp(),
      login = await webLogin(scoped),
      first = cookie(login),
      refresh = first.split('=')[1];
    expect(
      (await request(scoped).post('/api/v1/auth/refresh').send({ refresh_token: refresh })).status,
    ).toBe(401);
    const restored = await request(scoped)
      .post('/api/v1/auth/web/session')
      .set('Origin', origin)
      .set('Cookie', first);
    expect(restored.status).toBe(200);
    const logout = await request(scoped)
      .post('/api/v1/auth/web/logout')
      .set('Origin', origin)
      .set('Cookie', first)
      .set('X-CSRF-Token', login.body.data.csrf_token);
    expect(logout.status).toBe(204);
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(login.body.data.access_token, { type: 'bearer' })
      ).status,
    ).toBe(401);
  });
  it('sets Secure cookies in production behind a trusted proxy and permits credentialed CORS only for configured origins', async () => {
    const scoped = createApp(
      pool,
      redis,
      { ...webConfig, NODE_ENV: 'production', TRUST_PROXY: '127.0.0.1,::1' },
      engine,
    );
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [admin])).rows[0].email;
    const login = await request(scoped)
      .post('/api/v1/auth/web/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', origin)
      .send({ email, password: 'test-password-123' });
    expect(login.status, login.text).toBe(200);
    expect(login.headers['set-cookie']![0]).toContain('Secure');
    const preflight = await request(scoped)
      .options('/api/v1/auth/web/refresh')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-CSRF-Token');
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(
      (
        await request(scoped)
          .options('/api/v1/auth/web/refresh')
          .set('Origin', 'https://evil.example')
          .set('Access-Control-Request-Method', 'POST')
      ).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
  it('denies a revoked or downgraded web administrator on session restore and refresh', async () => {
    const scoped = webApp(),
      login = await webLogin(scoped);
    await pool.query("UPDATE users SET role='EMPLOYEE' WHERE id=$1", [admin]);
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/session')
          .set('Origin', origin)
          .set('Cookie', cookie(login))
      ).status,
    ).toBe(401);
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/refresh')
          .set('Origin', origin)
          .set('Cookie', cookie(login))
          .set('X-CSRF-Token', login.body.data.csrf_token)
      ).status,
    ).toBe(401);
  });
});

describe('admin reporting and schedule contracts', () => {
  async function categoryAdmin(category = 'KPID') {
    const id = (
      await pool.query(
        "INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code) VALUES($1,'Scoped admin',$2,$3,'ADMIN',$4) RETURNING id",
        [randomUUID(), randomUUID() + '@example.test', passwordHash, category],
      )
    ).rows[0].id;
    return (await issueSession(pool, config, id, randomUUID())).access_token;
  }
  it('paginates scoped users with filters and preserves total beyond the last page', async () => {
    const scoped = await categoryAdmin();
    const result = await request(app)
      .get('/api/v1/admin/users')
      .query({ q: 'Pegawai', active: 'true', limit: 1 })
      .auth(scoped, { type: 'bearer' });
    expect(result.status, result.text).toBe(200);
    expect(result.body.meta).toEqual({ limit: 1, offset: 0, total: 1 });
    expect(result.body.data[0].id).toBe(user);
    expect(result.body.data[0].password_hash).toBeUndefined();
    const page = await request(app)
      .get('/api/v1/admin/users')
      .query({ offset: 999 })
      .auth(scoped, { type: 'bearer' });
    expect(page.body.data).toEqual([]);
    expect(page.body.meta.total).toBe(1);
    expect(
      (
        await request(app)
          .get('/api/v1/admin/users/' + admin)
          .auth(scoped, { type: 'bearer' })
      ).status,
    ).toBe(403);
    const detail = await request(app)
      .get('/api/v1/admin/users/' + user)
      .auth(scoped, { type: 'bearer' });
    expect(detail.status).toBe(200);
    expect(detail.body.data.password_hash).toBeUndefined();
  });
  it('scopes attendance by both current and historical category and never returns biometric material', async () => {
    expect((await (await capture()).send()).status).toBe(201);
    const kpid = await categoryAdmin(),
      ki = await categoryAdmin('KI');
    const date = (await pool.query("SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date::text AS day"))
      .rows[0].day;
    const endpoint = '/api/v1/admin/attendances?from=' + date + '&to=' + date;
    const result = await request(app).get(endpoint).auth(kpid, { type: 'bearer' });
    expect(result.status, result.text).toBe(200);
    expect(result.body.meta.total).toBe(1);
    expect(result.body.data[0].user_id).toBe(user);
    expect(JSON.stringify(result.body)).not.toContain('encrypted_embedding');
    expect((await request(app).get(endpoint).auth(ki, { type: 'bearer' })).body.meta.total).toBe(0);
    expect((await request(app).get(endpoint).auth(access, { type: 'bearer' })).status).toBe(403);
    expect(
      (
        await request(app)
          .get(endpoint + '&status=EARLY_LEAVE')
          .auth(kpid, { type: 'bearer' })
      ).body.meta.total,
    ).toBe(0);
    await pool.query("UPDATE users SET employee_category_code='KI' WHERE id=$1", [user]);
    expect((await request(app).get(endpoint).auth(kpid, { type: 'bearer' })).body.meta.total).toBe(
      0,
    );
    expect((await request(app).get(endpoint).auth(ki, { type: 'bearer' })).body.meta.total).toBe(0);
    expect(
      (await request(app).get(endpoint).auth(adminAccess, { type: 'bearer' })).body.meta.total,
    ).toBe(1);
  });
  it('allows scoped schedule edits with an audit reason and locks schedules once attendance exists', async () => {
    const kpid = await categoryAdmin(),
      ki = await categoryAdmin('KI');
    const date = (await pool.query("SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date::text AS day"))
      .rows[0].day;
    const list = await request(app)
      .get('/api/v1/admin/schedules')
      .query({ from: date, to: date, user_id: user })
      .auth(kpid, { type: 'bearer' });
    expect(list.status, list.text).toBe(200);
    expect(list.body.meta.total).toBe(1);
    const id = list.body.data[0].id;
    expect(
      (
        await request(app)
          .patch('/api/v1/admin/schedules/' + id)
          .auth(ki, { type: 'bearer' })
          .send({ grace_minutes: 5, reason: 'Update grace period' })
      ).status,
    ).toBe(403);
    const updated = await request(app)
      .patch('/api/v1/admin/schedules/' + id)
      .auth(kpid, { type: 'bearer' })
      .send({ grace_minutes: 5, reason: 'Update grace period' });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body.data.grace_minutes).toBe(5);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action='SCHEDULE_UPDATED' AND target_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(1);
    expect((await (await capture()).send()).status).toBe(201);
    const locked = await request(app)
      .patch('/api/v1/admin/schedules/' + id)
      .auth(adminAccess, { type: 'bearer' })
      .send({ grace_minutes: 10, reason: 'Attempt history rewrite' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('SCHEDULE_LOCKED');
  });
  it('returns field validation details without reflecting submitted passwords', async () => {
    const result = await request(app)
      .post('/api/v1/admin/users')
      .auth(adminAccess, { type: 'bearer' })
      .send({ password: 'secret' });
    expect(result.status).toBe(400);
    expect(
      result.body.error.details.some((v: { field: string }) => v.field === 'employee_number'),
    ).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });
  it('paginates device/enrollment approvals without leaking other category records or embeddings', async () => {
    const kpid = await categoryAdmin(),
      ki = await categoryAdmin('KI');
    const devices = await request(app)
      .get('/api/v1/admin/devices?status=ACTIVE')
      .auth(kpid, { type: 'bearer' });
    expect(devices.status, devices.text).toBe(200);
    expect(devices.body.meta.total).toBe(1);
    expect(devices.body.data[0].public_key).toBeUndefined();
    expect(
      (await request(app).get('/api/v1/admin/devices').auth(ki, { type: 'bearer' })).body.meta
        .total,
    ).toBe(0);
    const faces = await request(app)
      .get('/api/v1/admin/face-enrollments?status=ACTIVE')
      .auth(kpid, { type: 'bearer' });
    expect(faces.status, faces.text).toBe(200);
    expect(faces.body.meta.total).toBe(1);
    expect(faces.body.data[0].encrypted_embedding).toBeUndefined();
    const audit = await request(app)
      .get('/api/v1/admin/audit-logs?limit=1&offset=999999')
      .auth(adminAccess, { type: 'bearer' });
    expect(audit.status).toBe(400);
  });
});

describe('Google native and browser login integration', () => {
  const origin = 'https://admin.example.test';
  const googleConfig = {
    ...config,
    GOOGLE_ENABLED: 'true' as const,
    WEB_AUTH_ENABLED: 'true' as const,
    ADMIN_WEB_ORIGIN: origin,
    GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fixture',
    GOOGLE_REDIRECT_URI: 'https://api.example.test/api/v1/auth/web/google/callback',
  };
  const provider = {
    authorizationUrl: async (flow: { state: string; nonce: string; code_challenge: string }) =>
      'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(flow).toString(),
    verifyCode: async (_flow: unknown, code: string, _verifier: string) => {
      if (!['admin-code', 'employee-code'].includes(code)) throw new Error('Invalid code');
      return {
        issuer: 'https://accounts.google.com',
        subject: code === 'admin-code' ? 'admin-subject' : 'employee-subject',
      };
    },
    verifyIdToken: async (value: string, nonce: string) => {
      const [subject, expected] = value.split('|');
      if (expected !== nonce || !subject) throw new Error('Invalid ID token');
      return { issuer: 'https://accounts.google.com', subject };
    },
  };
  async function prepare() {
    await pool.query("UPDATE users SET auth_mode='BOTH' WHERE id IN ($1,$2)", [user, admin]);
    await pool.query(
      "INSERT INTO sso_identities(user_id,issuer,subject) VALUES($1,'https://accounts.google.com','admin-subject'),($2,'https://accounts.google.com','employee-subject')",
      [admin, user],
    );
    return createApp(pool, redis, googleConfig, engine, undefined, provider);
  }
  it('exchanges a nonce-bound Google ID token for application tokens and refuses replay or unlinked identities', async () => {
    const scoped = await prepare();
    const challenge = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    expect(challenge.status).toBe(201);
    const body = {
      challenge_id: challenge.body.data.challenge_id,
      id_token: 'employee-subject|' + challenge.body.data.nonce,
    };
    const login = await request(scoped).post('/api/v1/auth/google').send(body);
    expect(login.status, login.text).toBe(200);
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(login.body.data.access_token, { type: 'bearer' })
      ).body.data.id,
    ).toBe(user);
    expect((await request(scoped).post('/api/v1/auth/google').send(body)).status).toBe(401);
    const next = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    const unlinked = await request(scoped)
      .post('/api/v1/auth/google')
      .send({
        challenge_id: next.body.data.challenge_id,
        id_token: 'unlinked|' + next.body.data.nonce,
      });
    expect(unlinked.status).toBe(403);
    expect(unlinked.body.error.code).toBe('SSO_ACCOUNT_NOT_LINKED');
  });
  it('rejects expired challenges, wrong nonces, disabled accounts, and disabled Google configuration', async () => {
    const scoped = await prepare();
    const challenge = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    const wrong = await request(scoped)
      .post('/api/v1/auth/google')
      .send({ challenge_id: challenge.body.data.challenge_id, id_token: 'employee-subject|wrong' });
    expect(wrong.status).toBe(401);
    const expired = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    await pool.query(
      "UPDATE google_login_flows SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.body.data.challenge_id],
    );
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/google')
          .send({
            challenge_id: expired.body.data.challenge_id,
            id_token: 'employee-subject|' + expired.body.data.nonce,
          })
      ).status,
    ).toBe(401);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [user]);
    const disabled = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/google')
          .send({
            challenge_id: disabled.body.data.challenge_id,
            id_token: 'employee-subject|' + disabled.body.data.nonce,
          })
      ).status,
    ).toBe(403);
    expect((await request(app).post('/api/v1/auth/google/challenge').send({})).status).toBe(503);
  });
  it('binds a web callback to its initiating browser and sends no application tokens in the redirect', async () => {
    const scoped = await prepare();
    const start = await request(scoped)
      .post('/api/v1/auth/web/google/start')
      .set('Origin', origin)
      .send({});
    expect(start.status, start.text).toBe(201);
    const flowCookie = (start.headers['set-cookie'] as unknown as string[])
      .find((v) => v.startsWith('absensi_google_flow='))!
      .split(';')[0]!;
    const state = new URL(start.body.data.authorization_url).searchParams.get('state')!;
    const path = '/api/v1/auth/web/google/callback';
    const wrong = await request(scoped)
      .get(path)
      .query({ state, code: 'admin-code' })
      .set('Cookie', 'absensi_google_flow=' + 'x'.repeat(43));
    expect(wrong.status).toBe(303);
    expect(wrong.headers.location).toBe(origin + '/login?error=SSO_LOGIN_FAILED');
    const callback = await request(scoped)
      .get(path)
      .query({ state, code: 'admin-code' })
      .set('Cookie', flowCookie);
    expect(callback.status, callback.text).toBe(303);
    expect(callback.headers.location).toBe(origin + '/auth/callback');
    expect(callback.headers.location).not.toContain('token');
    const refreshCookie = (callback.headers['set-cookie'] as unknown as string[])
      .find((v) => v.startsWith('absensi_web_refresh='))!
      .split(';')[0]!;
    const csrf = await request(scoped)
      .post('/api/v1/auth/web/session')
      .set('Origin', origin)
      .set('Cookie', refreshCookie);
    expect(csrf.status).toBe(200);
    const session = await request(scoped)
      .post('/api/v1/auth/web/refresh')
      .set('Origin', origin)
      .set('Cookie', refreshCookie)
      .set('X-CSRF-Token', csrf.body.data.csrf_token);
    expect(session.status, session.text).toBe(200);
    expect(session.body.data.refresh_token).toBeUndefined();
    expect(
      (
        await request(scoped)
          .get('/api/v1/me')
          .auth(session.body.data.access_token, { type: 'bearer' })
      ).body.data.id,
    ).toBe(admin);
    const replay = await request(scoped)
      .get(path)
      .query({ state, code: 'admin-code' })
      .set('Cookie', flowCookie);
    expect(replay.headers.location).toBe(origin + '/login?error=SSO_LOGIN_FAILED');
  });
  it('refuses employee access to the admin panel after valid Google authentication', async () => {
    const scoped = await prepare();
    const start = await request(scoped)
      .post('/api/v1/auth/web/google/start')
      .set('Origin', origin)
      .send({});
    const flowCookie = (start.headers['set-cookie'] as unknown as string[])
      .find((v) => v.startsWith('absensi_google_flow='))!
      .split(';')[0]!;
    const state = new URL(start.body.data.authorization_url).searchParams.get('state')!;
    const callback = await request(scoped)
      .get('/api/v1/auth/web/google/callback')
      .query({ state, code: 'employee-code' })
      .set('Cookie', flowCookie);
    expect(callback.headers.location).toBe(origin + '/login?error=SSO_LOGIN_FAILED');
    expect(
      (
        await pool.query("SELECT 1 FROM refresh_sessions WHERE user_id=$1 AND client_type='WEB'", [
          user,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await request(scoped)
          .post('/api/v1/auth/web/google/start')
          .set('Origin', 'https://evil.example')
          .send({})
      ).status,
    ).toBe(403);
  });
});

describe('Google verified email first login', () => {
  const email = 'existing.employee@gmail.com';
  const provider = {
    authorizationUrl: async () => 'https://accounts.google.com/',
    verifyCode: async () => {
      throw new Error('Web auto linking is not supported');
    },
    verifyIdToken: async (value: string, nonce: string) => {
      const claims = JSON.parse(value);
      if (claims.nonce !== nonce || !claims.sub) throw new Error('Invalid token');
      return {
        issuer: 'https://accounts.google.com',
        subject: claims.sub,
        verified_email: googleEmailForLinking(claims),
      };
    },
  };
  function linkingApp(enabled: 'true' | 'false' = 'true') {
    return createApp(
      pool,
      redis,
      {
        ...config,
        GOOGLE_ENABLED: 'true',
        GOOGLE_EMAIL_LINKING_ENABLED: enabled,
        GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com',
      },
      engine,
      undefined,
      provider,
    );
  }
  async function prepareEmployee() {
    await pool.query('UPDATE users SET email=$2 WHERE id=$1', [user, email]);
    const update = await request(app)
      .patch('/api/v1/admin/users/' + user)
      .auth(adminAccess, { type: 'bearer' })
      .send({ auth_mode: 'BOTH', google_email_linking_allowed: true });
    expect(update.status, update.text).toBe(200);
  }
  async function exchange(
    scoped: ReturnType<typeof createApp>,
    subject: string,
    claims: Record<string, unknown> = { email, email_verified: true },
  ) {
    const challenge = await request(scoped).post('/api/v1/auth/google/challenge').send({});
    expect(challenge.status, challenge.text).toBe(201);
    return request(scoped)
      .post('/api/v1/auth/google')
      .send({
        challenge_id: challenge.body.data.challenge_id,
        id_token: JSON.stringify({ ...claims, sub: subject, nonce: challenge.body.data.nonce }),
      });
  }
  it('links only an existing eligible employee and returns authoritative database profile through me', async () => {
    await prepareEmployee();
    const login = await exchange(linkingApp(), 'first-google-subject', {
      email: 'Existing.Employee@Gmail.com',
      email_verified: true,
      name: 'Untrusted Google display name',
      employee_number: 'OVERRIDE',
      employee_category_code: 'KI',
    });
    expect(login.status, login.text).toBe(200);
    const me = await request(app)
      .get('/api/v1/me')
      .auth(login.body.data.access_token, { type: 'bearer' });
    expect(me.body.data).toMatchObject({
      id: user,
      employee_number: 'U1',
      name: 'Pegawai KPID',
      email,
      employee_category_code: 'KPID',
      auth_mode: 'BOTH',
    });
    expect(
      (
        await pool.query('SELECT user_id FROM sso_identities WHERE subject=$1', [
          'first-google-subject',
        ])
      ).rows[0].user_id,
    ).toBe(user);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action='GOOGLE_IDENTITY_AUTO_LINKED' AND actor_id=$1",
          [user],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('preserves disabled-by-default behavior and does not create employees', async () => {
    await prepareEmployee();
    const result = await exchange(linkingApp('false'), 'unlinked');
    expect(result.status).toBe(403);
    expect((await pool.query('SELECT 1 FROM sso_identities')).rowCount).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(2);
  });
  it.each([
    { label: 'unknown email', claims: { email: 'unknown@gmail.com', email_verified: true } },
    { label: 'unverified email', claims: { email, email_verified: false } },
    {
      label: 'untrusted third-party email',
      claims: { email: 'existing.employee@thirdparty.test', email_verified: true },
    },
  ])('refuses $label without creating a mapping', async ({ claims }) => {
    await prepareEmployee();
    if (claims.email.endsWith('@thirdparty.test'))
      await pool.query('UPDATE users SET email=$2 WHERE id=$1', [user, claims.email]);
    const result = await exchange(linkingApp(), 'unlinked', claims);
    expect(result.status).toBe(403);
    expect((await pool.query('SELECT 1 FROM sso_identities')).rowCount).toBe(0);
  });
  it.each(['inactive', 'LOCAL', 'ADMIN', 'SUPER_ADMIN', 'not-approved'])(
    'refuses automatic linking for %s accounts',
    async (condition) => {
      await prepareEmployee();
      if (condition === 'inactive')
        await pool.query('UPDATE users SET active=false WHERE id=$1', [user]);
      else if (condition === 'not-approved')
        await pool.query('UPDATE users SET google_email_linking_allowed=false WHERE id=$1', [user]);
      else if (condition === 'LOCAL')
        await pool.query("UPDATE users SET auth_mode='LOCAL' WHERE id=$1", [user]);
      else await pool.query('UPDATE users SET role=$2 WHERE id=$1', [user, condition]);
      const result = await exchange(linkingApp(), 'unlinked');
      expect(result.status).toBe(403);
      expect((await pool.query('SELECT 1 FROM sso_identities')).rowCount).toBe(0);
    },
  );
  it('does not replace an existing Google subject with another matching email', async () => {
    await prepareEmployee();
    await pool.query(
      "INSERT INTO sso_identities(user_id,issuer,subject) VALUES($1,'https://accounts.google.com','original')",
      [user],
    );
    const result = await exchange(linkingApp(), 'replacement');
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('SSO_IDENTITY_CONFLICT');
    expect(
      (await pool.query('SELECT subject FROM sso_identities WHERE user_id=$1', [user])).rows[0]
        .subject,
    ).toBe('original');
  });
  it('keeps the original subject mapping after the Google email changes', async () => {
    await prepareEmployee();
    const scoped = linkingApp();
    expect((await exchange(scoped, 'stable-subject')).status).toBe(200);
    const result = await exchange(scoped, 'stable-subject', {
      email: 'changed@gmail.com',
      email_verified: true,
    });
    expect(result.status, result.text).toBe(200);
    const me = await request(app)
      .get('/api/v1/me')
      .auth(result.body.data.access_token, { type: 'bearer' });
    expect(me.body.data).toMatchObject({ id: user, email });
  });
  it('serializes concurrent first logins and audits a single mapping', async () => {
    await prepareEmployee();
    const scoped = linkingApp();
    const results = await Promise.all([
      exchange(scoped, 'concurrent-subject'),
      exchange(scoped, 'concurrent-subject'),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(
      (await pool.query('SELECT 1 FROM sso_identities WHERE user_id=$1', [user])).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action='GOOGLE_IDENTITY_AUTO_LINKED' AND actor_id=$1",
          [user],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('does not auto-relink after an admin intentionally unlinks the Google account', async () => {
    await prepareEmployee();
    const scoped = linkingApp();
    expect((await exchange(scoped, 'unlink-subject')).status).toBe(200);
    const mapping = (await pool.query('SELECT id FROM sso_identities WHERE user_id=$1', [user]))
      .rows[0];
    const removed = await request(scoped)
      .delete('/api/v1/admin/sso/identities/' + mapping.id)
      .auth(adminAccess, { type: 'bearer' })
      .send({ reason: 'Revoke Google login for this account' });
    expect(removed.status, removed.text).toBe(204);
    expect((await exchange(scoped, 'unlink-subject')).status).toBe(403);
    expect(
      (await pool.query('SELECT google_email_linking_allowed FROM users WHERE id=$1', [user]))
        .rows[0].google_email_linking_allowed,
    ).toBe(false);
  });
  it('restricts auth mode changes to another super admin and revokes prior sessions', async () => {
    await prepareEmployee();
    expect((await request(app).get('/api/v1/me').auth(access, { type: 'bearer' })).status).toBe(
      401,
    );
    const self = await request(app)
      .patch('/api/v1/admin/users/' + admin)
      .auth(adminAccess, { type: 'bearer' })
      .send({ auth_mode: 'BOTH' });
    expect(self.status).toBe(403);
    await pool.query("UPDATE users SET role='ADMIN',employee_category_code='KPID' WHERE id=$1", [
      admin,
    ]);
    const scoped = await request(app)
      .patch('/api/v1/admin/users/' + user)
      .auth(adminAccess, { type: 'bearer' })
      .send({ auth_mode: 'SSO' });
    expect(scoped.status).toBe(403);
  });
});

describe('FCM token lifecycle and check-in reminder worker', () => {
  const pushConfig = {
    ...config,
    FCM_ENABLED: 'true' as const,
    FIREBASE_PROJECT_ID: 'test-push-project',
  };
  const token = 'test-fcm-' + 'a'.repeat(80);
  function at(time: string) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    return new Date(day + 'T' + time + '+07:00');
  }
  let sent: ReminderMessage[];
  let scoped: ReturnType<typeof createApp>;
  const sender = {
    send: async (message: ReminderMessage) => {
      sent.push(message);
    },
  };
  async function register(value = token, bearer = access, target = device) {
    return request(scoped)
      .post('/api/v1/devices/' + target + '/push-token')
      .auth(bearer, { type: 'bearer' })
      .send({
        token: value,
        signature: sign(
          null,
          Buffer.from(
            'push-token:' +
              (bearer === adminAccess ? admin : user) +
              ':' +
              target +
              ':' +
              hash(value),
          ),
          pair.privateKey,
        ).toString('base64'),
      });
  }
  beforeEach(async () => {
    sent = [];
    scoped = createApp(pool, redis, pushConfig, engine);
    await pool.query('UPDATE work_schedules SET starts_at=$2,grace_minutes=0 WHERE user_id=$1', [
      user,
      at('08:00:00'),
    ]);
  });
  async function prepared() {
    const r = await register();
    expect(r.status, r.text).toBe(204);
  }
  const run = (time: string, transport = sender) =>
    processCheckInReminders(pool, pushConfig, transport, () => at(time));
  it('registers and rotates one token per approved device without exposing tokens in responses or audit', async () => {
    await prepared();
    const replacement = 'replacement-' + 'b'.repeat(80);
    const result = await register(replacement);
    expect(result.status).toBe(204);
    expect(result.text).toBe('');
    const rows = (await pool.query('SELECT token,token_hash,project_id FROM device_push_tokens'))
      .rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: replacement,
      project_id: pushConfig.FIREBASE_PROJECT_ID,
      token_hash: hash(replacement),
    });
    const audit = JSON.stringify(
      (await pool.query("SELECT detail FROM audit_logs WHERE action='PUSH_TOKEN_REGISTERED'")).rows,
    );
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(replacement);
    expect(
      (
        await request(scoped)
          .delete('/api/v1/devices/' + device + '/push-token')
          .auth(access, { type: 'bearer' })
      ).status,
    ).toBe(204);
    expect((await pool.query('SELECT 1 FROM device_push_tokens')).rowCount).toBe(0);
  });
  it('rejects unauthenticated, foreign, pending and disabled registrations', async () => {
    expect(
      (
        await request(scoped)
          .post('/api/v1/devices/' + device + '/push-token')
          .send({ token })
      ).status,
    ).toBe(401);
    expect((await register(token, adminAccess)).status).toBe(403);
    expect(
      (
        await request(scoped)
          .delete('/api/v1/devices/' + device + '/push-token')
          .auth(adminAccess, { type: 'bearer' })
      ).status,
    ).toBe(403);
    await pool.query("UPDATE devices SET status='PENDING' WHERE id=$1", [device]);
    expect((await register()).status).toBe(403);
    const disabled = await request(app)
      .post('/api/v1/devices/' + device + '/push-token')
      .auth(access, { type: 'bearer' })
      .send({ token, signature: 'invalid-signature' });
    expect(disabled.status).toBe(503);
  });
  it('rejects malformed tokens and prevents a token from being assigned to another device', async () => {
    expect((await register('bad token with spaces')).status).toBe(400);
    await prepared();
    const other = (
      await pool.query(
        "INSERT INTO devices(user_id,public_key,platform,status) VALUES($1,$2,'ANDROID','ACTIVE') RETURNING id",
        [admin, publicKey],
      )
    ).rows[0].id;
    const result = await register(token, adminAccess, other);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('FCM_TOKEN_IN_USE');
  });
  it('requires proof of the approved device key when registering or changing the push destination', async () => {
    const denied = await request(scoped)
      .post('/api/v1/devices/' + device + '/push-token')
      .auth(access, { type: 'bearer' })
      .send({ token, signature: Buffer.alloc(64).toString('base64') });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('DEVICE_SIGNATURE_INVALID');
    expect((await pool.query('SELECT 1 FROM device_push_tokens')).rowCount).toBe(0);
  });
  it('requires a MOBILE session for registration', async () => {
    await pool.query("UPDATE refresh_sessions SET client_type='WEB' WHERE user_id=$1", [user]);
    expect((await register()).status).toBe(403);
  });
  it('sends once at 07:55 WIB for an 08:00 deadline, never before', async () => {
    await prepared();
    await run('07:54:59');
    expect(sent).toHaveLength(0);
    await run('07:55:00');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deadline.toISOString()).toBe(at('08:00:00').toISOString());
    await run('07:55:01');
    expect(sent).toHaveLength(1);
    expect(
      (await pool.query('SELECT status,attempts FROM notification_deliveries')).rows[0],
    ).toEqual({ status: 'SENT', attempts: 1 });
  });
  it('expires queued reminders at 08:00 WIB', async () => {
    await prepared();
    await run('07:54:00');
    await run('08:00:00');
    expect(sent).toHaveLength(0);
    expect(
      (await pool.query('SELECT status,last_error FROM notification_deliveries')).rows[0],
    ).toEqual({ status: 'SKIPPED', last_error: 'EXPIRED' });
  });
  it('suppresses reminders after successful check-in', async () => {
    await prepared();
    await run('07:54:00');
    const captured = await (await capture()).send();
    expect(captured.status, captured.text).toBe(201);
    await run('07:55:00');
    expect(sent).toHaveLength(0);
    expect(
      (await pool.query('SELECT last_error FROM notification_deliveries')).rows[0].last_error,
    ).toBe('ALREADY_CHECKED_IN');
  });
  it.each(['logout', 'inactive', 'revoked', 'unregistered', 'wrong-project'])(
    'rechecks eligibility before sending: %s',
    async (condition) => {
      await prepared();
      await run('07:54:00');
      if (condition === 'logout')
        await request(app).post('/api/v1/auth/logout').auth(access, { type: 'bearer' }).send({});
      else if (condition === 'inactive')
        await pool.query('UPDATE users SET active=false WHERE id=$1', [user]);
      else if (condition === 'revoked')
        await pool.query("UPDATE devices SET status='REVOKED' WHERE id=$1", [device]);
      else if (condition === 'wrong-project')
        await pool.query("UPDATE device_push_tokens SET project_id='another-project'");
      else
        await request(scoped)
          .delete('/api/v1/devices/' + device + '/push-token')
          .auth(access, { type: 'bearer' });
      await run('07:55:00');
      expect(sent).toHaveLength(0);
      expect((await pool.query('SELECT status FROM notification_deliveries')).rows[0].status).toBe(
        'SKIPPED',
      );
    },
  );
  it('retains notification eligibility across refresh token rotation', async () => {
    const session = await issueSession(pool, config, user, randomUUID());
    expect((await register(token, session.access_token)).status).toBe(204);
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: session.refresh_token });
    expect(rotated.status, rotated.text).toBe(200);
    await run('07:55:00');
    expect(sent).toHaveLength(1);
  });
  it('updates the reminder time when an administrator changes the schedule before delivery', async () => {
    await prepared();
    await run('07:54:00');
    await pool.query('UPDATE work_schedules SET starts_at=$2 WHERE user_id=$1', [
      user,
      at('08:30:00'),
    ]);
    await run('07:55:00');
    expect(sent).toHaveLength(0);
    await run('08:25:00');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deadline.toISOString()).toBe(at('08:30:00').toISOString());
  });
  it('moves a queued reminder to another work date before expiring the old deadline', async () => {
    await prepared();
    await run('07:54:00');
    const deadline = new Date(at('08:00:00').getTime() + 86400000);
    await pool.query(
      `UPDATE work_schedules SET work_date=($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date,
      starts_at=$2,ends_at=$2::timestamptz+interval '9 hours' WHERE user_id=$1`,
      [user, deadline],
    );
    await run('08:00:00');
    expect(sent).toHaveLength(0);
    expect((await pool.query('SELECT status FROM notification_deliveries')).rows[0].status).toBe(
      'PENDING',
    );
    await processCheckInReminders(
      pool,
      pushConfig,
      sender,
      () => new Date(deadline.getTime() - 300000),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deadline.toISOString()).toBe(deadline.toISOString());
  });
  it('retries transient failures with backoff and stops after three attempts', async () => {
    await prepared();
    let attempts = 0;
    const failed = {
      send: async () => {
        attempts++;
        throw { code: 'messaging/internal-error', message: 'DO_NOT_PERSIST_RAW_ERROR' };
      },
    };
    await run('07:55:00', failed);
    await run('07:55:04', failed);
    expect(attempts).toBe(1);
    await run('07:55:05', failed);
    await run('07:55:15', failed);
    await run('07:56:00', failed);
    expect(attempts).toBe(3);
    const row = (await pool.query('SELECT status,attempts,last_error FROM notification_deliveries'))
      .rows[0];
    expect(row).toEqual({ status: 'FAILED', attempts: 3, last_error: 'messaging/internal-error' });
  });
  it('removes only the invalid token that was sent, preserving a replacement registered in flight', async () => {
    await prepared();
    const replacement = 'replacement-' + 'c'.repeat(80);
    const invalid = {
      send: async () => {
        expect((await register(replacement)).status).toBe(204);
        throw { code: 'messaging/registration-token-not-registered' };
      },
    };
    await run('07:55:00', invalid);
    expect((await pool.query('SELECT token FROM device_push_tokens')).rows[0].token).toBe(
      replacement,
    );
    expect((await pool.query('SELECT status FROM notification_deliveries')).rows[0].status).toBe(
      'FAILED',
    );
  });
  it('removes an invalid token without retrying it', async () => {
    await prepared();
    let attempts = 0;
    await run('07:55:00', {
      send: async () => {
        attempts++;
        throw { code: 'messaging/invalid-registration-token' };
      },
    });
    await run('07:56:00');
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM device_push_tokens')).rowCount).toBe(0);
  });
  it('claims jobs safely across concurrent workers', async () => {
    await prepared();
    const slow = {
      send: async (message: ReminderMessage) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        sent.push(message);
      },
    };
    await Promise.all([run('07:55:00', slow), run('07:55:00', slow)]);
    expect(sent).toHaveLength(1);
  });
  it('recovers expired worker leases using the same notification id', async () => {
    await prepared();
    await enqueueReminders(pool, pushConfig.FIREBASE_PROJECT_ID, at('07:54:00'));
    const claimed = (await claimReminder(pool, at('07:55:00'))).rows[0];
    await run('07:55:30');
    expect(sent).toHaveLength(0);
    await run('07:57:00');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.notificationId).toBe(claimed!.id);
  });
  it.each(['holiday', 'leave'])(
    'skips a queued reminder after a new %s is recorded',
    async (kind) => {
      await prepared();
      await enqueueReminders(pool, pushConfig.FIREBASE_PROJECT_ID, at('07:54:00'));
      expect((await pool.query('SELECT id FROM notification_deliveries')).rowCount).toBe(1);
      if (kind === 'holiday') {
        await pool.query(
          "INSERT INTO holidays(holiday_date,name,type) VALUES(($1::timestamptz AT TIME ZONE 'Asia/Jakarta')::date,'Pilot holiday','NATIONAL_HOLIDAY')",
          [at('08:00:00')],
        );
      } else {
        await pool.query(
          "INSERT INTO leave_requests(user_id,category,start_date,end_date,notes,status) VALUES($1,'IZIN',($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date,($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date,'Pilot leave','APPROVED')",
          [user, at('08:00:00')],
        );
      }
      try {
        await run('07:55:00');
        expect(sent).toHaveLength(0);
        expect(
          (await pool.query('SELECT status,last_error FROM notification_deliveries')).rows[0],
        ).toEqual({ status: 'SKIPPED', last_error: kind === 'holiday' ? 'HOLIDAY' : 'ON_LEAVE' });
      } finally {
        if (kind === 'holiday') await pool.query("DELETE FROM holidays WHERE name='Pilot holiday'");
      }
    },
  );
});

describe('leave authorization, attendance conflicts and concurrency', () => {
  const payload = {
    category: 'IZIN',
    start_date: '2035-01-02',
    end_date: '2035-01-03',
    notes: 'Approved pilot test request',
  };
  const submit = () =>
    request(app).post('/api/v1/leaves').auth(access, { type: 'bearer' }).send(payload);
  const review = (id: string, bearer = adminAccess) =>
    request(app)
      .patch('/api/v1/admin/leaves/' + id)
      .auth(bearer, { type: 'bearer' })
      .send({ status: 'APPROVED', review_notes: 'Pilot verification' });

  it('serializes simultaneous overlapping submissions', async () => {
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe('LEAVE_OVERLAP');
    expect((await pool.query('SELECT id FROM leave_requests')).rowCount).toBe(1);
  });
  it('forbids a super admin reviewing their own request', async () => {
    const own = await request(app)
      .post('/api/v1/leaves')
      .auth(adminAccess, { type: 'bearer' })
      .send(payload);
    expect(own.status, own.text).toBe(201);
    const response = await review(own.body.data.id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });
  it('permits only one concurrent approval of legacy overlapping requests', async () => {
    const rows = await pool.query(
      "INSERT INTO leave_requests(user_id,category,start_date,end_date,notes) VALUES($1,'IZIN','2035-01-02','2035-01-03','Legacy request one'),($1,'CUTI','2035-01-02','2035-01-03','Legacy request two') RETURNING id",
      [user],
    );
    const responses = await Promise.all(rows.rows.map((r) => review(r.id)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await pool.query("SELECT id FROM leave_requests WHERE status='APPROVED'")).rowCount,
    ).toBe(1);
  });
  it('rejects full-day leave approval after check-in and preserves checkout', async () => {
    const checkin = await (await capture()).send();
    expect(checkin.status, checkin.text).toBe(201);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    const leave = await request(app)
      .post('/api/v1/leaves')
      .auth(access, { type: 'bearer' })
      .send({ ...payload, start_date: today, end_date: today });
    expect(leave.status, leave.text).toBe(201);
    const response = await review(leave.body.data.id);
    expect(response.status, response.text).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_ATTENDANCE_CONFLICT');
    expect((await (await capture('CHECK_OUT')).send()).status).toBe(201);
  });
  it('allows closing existing attendance even if legacy data has an approved leave', async () => {
    expect((await (await capture()).send()).status).toBe(201);
    await pool.query(
      "INSERT INTO leave_requests(user_id,category,start_date,end_date,notes,status) VALUES($1,'IZIN',(now() AT TIME ZONE 'Asia/Jakarta')::date,(now() AT TIME ZONE 'Asia/Jakarta')::date,'Legacy approved leave','APPROVED')",
      [user],
    );
    expect((await (await capture('CHECK_OUT')).send()).status).toBe(201);
  });
  it('blocks check-in on approved full-day leave', async () => {
    await pool.query(
      "INSERT INTO leave_requests(user_id,category,start_date,end_date,notes,status) VALUES($1,'IZIN',(now() AT TIME ZONE 'Asia/Jakarta')::date,(now() AT TIME ZONE 'Asia/Jakarta')::date,'Approved pilot leave','APPROVED')",
      [user],
    );
    const response = await (await capture()).send();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ON_LEAVE');
  });
  it('prevents category admins from reviewing another placement', async () => {
    const leave = await submit();
    await pool.query("UPDATE users SET role='ADMIN',employee_category_code='KI' WHERE id=$1", [
      admin,
    ]);
    expect((await review(leave.body.data.id)).status).toBe(403);
  });
  it('applies the advertised leave category filter', async () => {
    await submit();
    const response = await request(app)
      .get('/api/v1/admin/leaves?category=CUTI')
      .auth(adminAccess, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});
