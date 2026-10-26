import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { Config } from '../../config/env.js';
import { transaction, type Db } from '../../database/client.js';
import { audit } from '../../database/audit.js';
import { fail } from '../../shared/errors/api-error.js';
import type { User } from '../auth/auth.model.js';
import { managedUser } from '../admin/admin.service.js';
import { facePolicy } from '../face/face.policy.js';
import {
  attendanceStatus,
  resolveAttendanceContext,
  snapshotOffice,
} from './attendance.service.js';
import {
  findAttemptStatusForUpdate,
  insertAttendanceRecord,
  updateAttemptAccepted,
} from './attendance.model.js';
import {
  findReviewAttempt,
  listReviews,
  finishReview,
  type ReviewAttempt,
} from './attendance.review.model.js';
import {
  attendanceReviewEvidence,
  type attendanceReviewInput,
  type attendanceReviewQuery,
} from './attendance.review.schema.js';

async function authorizeReview(db: Db, actor: User, attempt: ReviewAttempt) {
  await managedUser(db, actor, attempt.user_id);
  if (
    actor.role !== 'SUPER_ADMIN' &&
    attempt.employee_category_at_event !== actor.employee_category_code
  ) {
    fail(403, 'FORBIDDEN', 'Review absensi di luar kategori kewenangan admin.');
  }
}

export function listAttendanceReviews(
  pool: Pool,
  actor: User,
  query: z.infer<typeof attendanceReviewQuery>,
) {
  return listReviews(pool, actor.role === 'SUPER_ADMIN', actor.employee_category_code, query);
}

export async function getAttendanceReview(pool: Pool, actor: User, id: string) {
  const attempt = (await findReviewAttempt(pool, id)).rows[0];
  if (!attempt || (attempt.review_status === null && attempt.attempt_status !== 'NEEDS_REVIEW'))
    fail(404, 'NOT_FOUND', 'Review absensi tidak ditemukan.');
  await authorizeReview(pool, actor, attempt);
  return attempt;
}

export async function decideAttendanceReview(
  pool: Pool,
  config: Config,
  actor: User,
  id: string,
  input: z.infer<typeof attendanceReviewInput>,
) {
  return transaction(pool, async (db) => {
    const initial = (await findReviewAttempt(db, id)).rows[0];
    if (!initial || (initial.review_status === null && initial.attempt_status !== 'NEEDS_REVIEW'))
      fail(404, 'NOT_FOUND', 'Review absensi tidak ditemukan.');
    if (initial.user_id === actor.id)
      fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Absensi sendiri harus ditinjau admin lain.');
    // Match the user-first lock order of capture, leave approval and face reset.
    await authorizeReview(db, actor, initial);
    await findAttemptStatusForUpdate(db, id);
    const attempt = (await findReviewAttempt(db, id)).rows[0]!;
    if (
      attempt.attempt_status !== 'NEEDS_REVIEW' ||
      (attempt.review_status !== null && attempt.review_status !== 'PENDING')
    )
      fail(409, 'REVIEW_ALREADY_RESOLVED', 'Review absensi sudah diselesaikan.');

    if (input.status === 'REJECTED') {
      await finishReview(
        db,
        attempt,
        actor.id,
        input.status,
        input.reason,
        input.identity_verified,
      );
      const response = {
        error: {
          code: 'ATTENDANCE_REVIEW_REJECTED',
          message: 'Absensi ditolak setelah peninjauan admin.',
        },
        attempt_id: id,
      };
      await db.query(
        "UPDATE attendance_attempts SET status='REJECTED',reason_code='ATTENDANCE_REVIEW_REJECTED',http_status=422,response=$2,completed_at=now() WHERE id=$1",
        [id, response],
      );
      await audit(db, actor.id, 'ATTENDANCE_REVIEW_REJECTED', id, {
        user_id: attempt.user_id,
        reason: input.reason,
      });
      return { attempt_id: id, status: 'REJECTED', attendance: null };
    }

    if (!input.identity_verified)
      fail(400, 'IDENTITY_VERIFICATION_REQUIRED', 'Identitas pegawai wajib diverifikasi.');
    const parsed = attendanceReviewEvidence.safeParse(attempt.evidence);
    if (!parsed.success)
      fail(
        409,
        'REVIEW_EVIDENCE_UNAVAILABLE',
        'Bukti validasi lama tidak tersedia. Tolak review dan minta percobaan absensi baru.',
      );
    const evidence = parsed.data;
    const policy = facePolicy(config);
    if (
      !isDeepStrictEqual(policy, evidence.policy) ||
      evidence.face_score < policy.review ||
      evidence.face_score >= policy.match ||
      evidence.liveness_score < policy.liveness ||
      evidence.quality_score < policy.quality
    )
      fail(
        409,
        'REVIEW_POLICY_CHANGED',
        'Kebijakan biometrik berubah atau bukti tidak memenuhi syarat. Minta absensi baru.',
      );
    const received = new Date(attempt.received_at);
    const current = await resolveAttendanceContext(
      db,
      attempt.user_id,
      { ...evidence.location, nonce: '', signature: '' },
      attempt.purpose,
      received,
      config,
    );
    const schedule = {
      id: current.schedule.id,
      starts_at: new Date(current.schedule.starts_at).toISOString(),
      ends_at: new Date(current.schedule.ends_at).toISOString(),
      grace_minutes: current.schedule.grace_minutes,
    };
    if (
      current.category !== attempt.employee_category_at_event ||
      current.template.id !== evidence.template_id ||
      !isDeepStrictEqual(snapshotOffice(current.office), evidence.office) ||
      !isDeepStrictEqual(schedule, evidence.schedule)
    )
      fail(
        409,
        'REVIEW_CONTEXT_CHANGED',
        'Kategori, wajah, kantor atau jadwal berubah. Minta absensi baru.',
      );

    const inserted = await insertAttendanceRecord(db, {
      userId: attempt.user_id,
      scheduleId: current.schedule.id,
      attemptId: id,
      officeId: current.office.id,
      deviceId: evidence.location.device_id,
      purpose: attempt.purpose,
      received,
      category: current.category,
      officeSnapshot: evidence.office,
      latitude: evidence.location.latitude,
      longitude: evidence.location.longitude,
      accuracy_m: evidence.location.accuracy_m,
      distance_m: current.office.distance_m,
      score: evidence.face_score,
      liveness_score: evidence.liveness_score,
      model_version: policy.model_version,
      policySnapshot: {
        ...policy,
        schedule: {
          starts_at: current.schedule.starts_at,
          ends_at: current.schedule.ends_at,
          grace_minutes: current.schedule.grace_minutes,
        },
        verification_method: 'ADMIN_REVIEW',
        reviewed_by: actor.id,
      },
      status: attendanceStatus(attempt.purpose, received, current.schedule),
    });
    const data = {
      ...inserted.rows[0],
      attempt_id: id,
      office_code: current.office.code,
      geofence_type: 'POLYGON',
      radius_m: current.office.radius_m ?? 50,
      verification_status: 'ACCEPTED',
      verification_method: 'ADMIN_REVIEW',
    };
    await finishReview(db, attempt, actor.id, input.status, input.reason, true);
    await updateAttemptAccepted(db, id, { data });
    await audit(db, actor.id, 'ATTENDANCE_REVIEW_APPROVED', id, {
      user_id: attempt.user_id,
      attendance_id: inserted.rows[0]!.id,
      reason: input.reason,
      identity_verified: true,
    });
    return { attempt_id: id, status: 'APPROVED', attendance: data };
  });
}
