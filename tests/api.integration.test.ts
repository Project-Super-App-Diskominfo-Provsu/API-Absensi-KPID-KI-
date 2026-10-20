import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';
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

const databaseName = `absensi_test_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://absensi:local-development-only@localhost:55432/absensi';
const adminPool = new Pool({ connectionString: adminUrl });
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const pool = new Pool({ connectionString: testUrl.toString(), max: 15 });
const redis = createClient({ url: process.env.TEST_REDIS_URL ?? 'redis://localhost:56379' });
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
let workerHook: (() => Promise<void>) | undefined;
const engine: FaceEngine = {
  ready: async () => true,
  observe: async () => {
    await workerHook?.();
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
beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  await pool.query(
    await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'),
  );
  await redis.connect();
  await pool.query(await readFile(new URL('../migrations/002_sso.sql', import.meta.url), 'utf8'));
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
  await pool.query(`UPDATE offices SET location=ST_SetSRID(ST_MakePoint(CASE code WHEN 'DISKOMINFO_PROVSU' THEN 98.6 WHEN 'KPID_SUMUT' THEN 98.61 ELSE 98.62 END,3.5),4326)::geography,
    max_gps_accuracy_m=15,max_location_age_s=30,active=true`);
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
  it('enforces the radius in PostGIS with points just inside and outside 50m', async () => {
    for (const [distance, allowed] of [
      [49.99, true],
      [50.01, false],
    ] as const) {
      const point = (
        await pool.query(
          'SELECT ST_Y(p::geometry) AS lat,ST_X(p::geometry) AS lng FROM (SELECT ST_Project(location,$2::float8,0::float8) p FROM offices WHERE id=$1) q',
          [offices.DISKOMINFO_PROVSU, distance],
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
      if (allowed) expect((await result).distance_m).toBeLessThan(50);
      else await expect(result).rejects.toMatchObject({ code: 'GEOFENCE_OUT_OF_RANGE' });
    }
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
    await pool.query('UPDATE offices SET active=false,location=NULL WHERE id=$1', [
      offices.KI_SUMUT,
    ]);
    const result = await request(app)
      .patch(`/api/v1/admin/offices/${offices.KI_SUMUT}`)
      .auth(adminAccess, { type: 'bearer' })
      .send({ active: true });
    expect(result.body.error.code).toBe('OFFICE_NOT_CONFIGURED');
  });
  it('enforces radius 50 at the database and API layers', async () => {
    expect(
      (
        await request(app)
          .patch(`/api/v1/admin/offices/${offices.KI_SUMUT}`)
          .auth(adminAccess, { type: 'bearer' })
          .send({ radius_m: 100 })
      ).status,
    ).toBe(400);
    await expect(
      pool.query('UPDATE offices SET radius_m=100 WHERE id=$1', [offices.KI_SUMUT]),
    ).rejects.toMatchObject({ code: '23514' });
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
