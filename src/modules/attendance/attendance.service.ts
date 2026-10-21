import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { audit } from '../../database/audit.js';
import { transaction, type Db } from '../../database/client.js';
import { activeDevice } from '../device/device.service.js';
import { consumeAttendanceChallenge } from '../device/device.model.js';
import { selectOffice, type Office } from '../office/office.service.js';
import { findActiveFaceTemplate } from '../face/face.model.js';
import { facePolicy, similarity } from '../face/face.policy.js';
import { validateObservation } from '../face/face.policy.js';
import { type FaceEngine } from '../face/face.types.js';
import { decrypt, hash, verifyDeviceSignature } from '../../shared/security/crypto.js';
import { ApiError, fail } from '../../shared/errors/api-error.js';
import type { User } from '../auth/auth.model.js';
import {
  findUserCategoryAndActive,
  findWorkScheduleForDate,
  findExistingAttendances,
  findAttendanceAttemptForUpdate,
  insertAttendanceAttempt,
  updateAttemptExpired,
  countRecentRejectedAttempts,
  findAttemptStatusForUpdate,
  updateAttemptReview,
  insertAttendanceRecord,
  updateAttemptAccepted,
  updateAttemptFailed,
  findAttemptResponse,
  findAttendanceAttemptByIdAndUser,
  findAttendanceHistory,
  snapshotOfficeModel,
} from './attendance.model.js';

export type Purpose = 'CHECK_IN' | 'CHECK_OUT';

export interface AttendanceInputData {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  captured_at: string;
  device_id: string;
  nonce: string;
  signature: string;
  office_id?: string;
  is_mock: 'true' | 'false';
}

export function attendancePayload(
  userId: string,
  purpose: Purpose,
  key: string,
  input: AttendanceInputData,
  image: Buffer,
): string {
  return JSON.stringify({
    user_id: userId,
    purpose,
    idempotency_key: key,
    device_id: input.device_id,
    nonce: input.nonce,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_m: input.accuracy_m,
    captured_at: input.captured_at,
    office_id: input.office_id ?? null,
    is_mock: input.is_mock,
    image_sha256: hash(image),
  });
}

export function snapshotOffice(office: Office) {
  return snapshotOfficeModel(office);
}

export async function resolveAttendanceContext(
  db: Db,
  userId: string,
  input: AttendanceInputData,
  purpose: Purpose,
  received: Date,
  config: Config,
) {
  const users = await findUserCategoryAndActive(db, userId);
  const user = users.rows[0];
  if (!user?.active) fail(403, 'USER_INACTIVE', 'Akun tidak aktif.');
  if (input.is_mock === 'true') {
    fail(403, 'MOCK_LOCATION_DETECTED', 'Lokasi tiruan tidak diizinkan.');
  }

  await activeDevice(db, userId, input.device_id);
  const office = await selectOffice(db, user.employee_category_code, input, received);
  const schedules = await findWorkScheduleForDate(db, userId, received);
  const schedule = schedules.rows[0];
  if (!schedule) fail(409, 'SCHEDULE_NOT_FOUND', 'Jadwal kerja hari ini belum tersedia.');

  const existing = await findExistingAttendances(db, userId, schedule.id);
  if (existing.rows.some((v) => v.type === purpose)) {
    fail(409, 'DUPLICATE_ATTENDANCE', 'Absensi jenis ini sudah tercatat.');
  }
  if (purpose === 'CHECK_OUT') {
    const checkIn = existing.rows.find((v) => v.type === 'CHECK_IN');
    if (!checkIn) fail(409, 'CHECK_IN_REQUIRED', 'Absen masuk diperlukan sebelum absen pulang.');
  }

  const faces = await findActiveFaceTemplate(db, userId);
  const template = faces.rows[0];
  if (!template) fail(409, 'FACE_NOT_ENROLLED', 'Wajah belum terdaftar dan disetujui.');
  if (template.model_version !== config.FACE_MODEL_VERSION) {
    fail(409, 'FACE_REENROLL_REQUIRED', 'Model berubah. Enrollment ulang diperlukan.');
  }

  return { category: user.employee_category_code as string, office, schedule, template };
}

export async function recordAttendance(
  pool: Pool,
  config: Config,
  engine: FaceEngine,
  user: User,
  purpose: Purpose,
  key: string,
  input: AttendanceInputData,
  image: Buffer,
) {
  const received = new Date();
  const payload = attendancePayload(user.id, purpose, key, input, image);
  const digest = hash(payload);

  const reservation = await transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const old = await findAttendanceAttemptForUpdate(db, user.id, key);
    if (old.rowCount) {
      const attempt = old.rows[0]!;
      if (attempt.request_hash !== digest) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'Key sudah digunakan untuk isi permintaan berbeda.');
      }
      if (
        attempt.status === 'PROCESSING' &&
        Date.now() - new Date(attempt.received_at).getTime() > 60000
      ) {
        const response = {
          error: {
            code: 'PROCESSING_EXPIRED',
            message: 'Pemrosesan terputus. Buat challenge dan key baru.',
          },
          attempt_id: attempt.id,
        };
        await updateAttemptExpired(db, attempt.id, response);
        return { id: attempt.id, http_status: 503, response };
      }
      return {
        id: attempt.id,
        http_status: attempt.http_status ?? 202,
        response: attempt.response ?? {
          data: { attempt_id: attempt.id, status: 'PROCESSING' },
        },
      };
    }
    const row = await insertAttendanceAttempt(db, user.id, key, digest, purpose, received);
    return { id: row.rows[0]!.id as string, http_status: null, response: null };
  });

  if (reservation.response) {
    return {
      httpStatus: reservation.http_status!,
      body: reservation.response as Record<string, unknown>,
    };
  }

  try {
    const policy = facePolicy(config);
    const consumedChallenge = await transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const device = await activeDevice(db, user.id, input.device_id);
      verifyDeviceSignature(device.public_key, input.signature, payload);
      const challenge = await consumeAttendanceChallenge(
        db,
        hash(input.nonce),
        user.id,
        input.device_id,
        purpose,
      );
      if (!challenge.rowCount) {
        fail(409, 'REPLAY_DETECTED', 'Challenge tidak valid, kedaluwarsa, atau telah digunakan.');
      }
      return challenge.rows[0]! as { created_at: Date };
    });

    if (Date.parse(input.captured_at) < new Date(consumedChallenge.created_at).getTime() - 5000) {
      fail(422, 'LOCATION_STALE', 'Ambil lokasi setelah challenge diterbitkan.');
    }

    const failed = await countRecentRejectedAttempts(pool, user.id);
    if (failed.rows[0]!.count >= 5) {
      fail(429, 'RATE_LIMITED', 'Terlalu banyak percobaan ditolak. Tunggu 15 menit.');
    }

    const initial = await resolveAttendanceContext(pool, user.id, input, purpose, received, config);
    const observation = await engine.observe(image, input.nonce);
    validateObservation(observation, config);

    const score = similarity(
      decrypt(initial.template.encrypted_embedding, config.BIOMETRIC_KEY_BASE64, user.id),
      observation.embedding,
    );
    if (score < policy.review) {
      fail(422, 'FACE_NOT_MATCHED', 'Wajah tidak cocok dengan pegawai.');
    }

    const output = await transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const attempt = await findAttemptStatusForUpdate(db, reservation.id);
      if (attempt.rows[0]!.status !== 'PROCESSING') {
        fail(409, 'ATTEMPT_CLOSED', 'Percobaan sudah ditutup.');
      }

      const final = await resolveAttendanceContext(db, user.id, input, purpose, received, config);
      if (
        final.template.id !== initial.template.id ||
        final.category !== initial.category ||
        hash(JSON.stringify(snapshotOffice(final.office))) !==
          hash(JSON.stringify(snapshotOffice(initial.office)))
      ) {
        fail(409, 'POLICY_CHANGED', 'Data pegawai, wajah, atau lokasi berubah. Ulangi absensi.');
      }

      if (score < policy.match) {
        const body = {
          data: {
            attempt_id: reservation.id,
            status: 'NEEDS_REVIEW',
            reason_code: 'FACE_REVIEW_REQUIRED',
          },
        };
        await updateAttemptReview(db, reservation.id, body);
        await audit(db, user.id, 'ATTENDANCE_REVIEW_REQUIRED', reservation.id, {
          office_id: final.office.id,
        });
        return { status: 202, body };
      }

      const status =
        purpose === 'CHECK_IN'
          ? received.getTime() >
            new Date(final.schedule.starts_at).getTime() + final.schedule.grace_minutes * 60000
            ? 'LATE'
            : 'PRESENT'
          : received.getTime() < new Date(final.schedule.ends_at).getTime()
            ? 'EARLY_LEAVE'
            : 'ON_TIME';

      const inserted = await insertAttendanceRecord(db, {
        userId: user.id,
        scheduleId: final.schedule.id,
        attemptId: reservation.id,
        officeId: final.office.id,
        deviceId: input.device_id,
        purpose,
        received,
        category: final.category,
        officeSnapshot: snapshotOffice(final.office),
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy_m: input.accuracy_m,
        distance_m: final.office.distance_m,
        score,
        liveness_score: observation.liveness_score,
        model_version: observation.model_version,
        policySnapshot: {
          ...policy,
          schedule: {
            starts_at: final.schedule.starts_at,
            ends_at: final.schedule.ends_at,
            grace_minutes: final.schedule.grace_minutes,
          },
        },
        status,
      });

      const body = {
        data: {
          ...inserted.rows[0],
          attempt_id: reservation.id,
          office_code: final.office.code,
          geofence_type: 'POLYGON',
          distance_m: final.office.distance_m,
          radius_m: final.office.radius_m ?? 50,
          verification_status: 'ACCEPTED',
        },
      };

      await updateAttemptAccepted(db, reservation.id, body);
      await audit(db, user.id, 'ATTENDANCE_ACCEPTED', inserted.rows[0]!.id, {
        office_id: final.office.id,
        type: purpose,
      });
      return { status: 201, body };
    });

    return { httpStatus: output.status, body: output.body };
  } catch (error) {
    const known = error instanceof ApiError;
    const code = known ? error.code : 'ATTENDANCE_PROCESSING_FAILED';
    const status = known ? error.status : 503;
    const body = {
      error: {
        code,
        message: known ? error.message : 'Pemrosesan absensi gagal. Buat challenge baru.',
      },
      attempt_id: reservation.id,
    };
    const result = await updateAttemptFailed(
      pool,
      reservation.id,
      status >= 500 ? 'ERROR' : 'REJECTED',
      code,
      status,
      body,
    );
    if (!result.rowCount) {
      const saved = await findAttemptResponse(pool, reservation.id);
      return {
        httpStatus: saved.rows[0]!.http_status ?? 409,
        body: (saved.rows[0]!.response as Record<string, unknown>) ?? body,
      };
    }
    return { httpStatus: status, body };
  }
}

export async function getAttendanceAttempt(pool: Pool, userId: string, id: string) {
  const row = await findAttendanceAttemptByIdAndUser(pool, id, userId);
  if (!row.rowCount) fail(404, 'NOT_FOUND', 'Percobaan tidak ditemukan.');
  return row.rows[0]!;
}

export async function getAttendanceHistory(
  pool: Pool,
  userId: string,
  from: string,
  to: string,
  limit: number,
  offset: number,
) {
  const rows = await findAttendanceHistory(pool, userId, from, to, limit, offset);
  return rows.rows;
}
