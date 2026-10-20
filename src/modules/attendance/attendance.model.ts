import type { Db } from '../../database/client.js';
import type { Office } from '../office/office.model.js';

export interface AttendanceRecord {
  id: string;
  user_id: string;
  schedule_id: string;
  attempt_id: string;
  office_id: string;
  device_id: string;
  type: 'CHECK_IN' | 'CHECK_OUT';
  server_time: Date;
  employee_category_at_event: string;
  office_snapshot: ReturnType<typeof snapshotOfficeModel>;
  latitude: number;
  longitude: number;
  gps_accuracy: number;
  distance_m: number;
  face_score: number;
  liveness_score: number;
  model_version: string;
  policy_snapshot: Record<string, unknown>;
  status: 'PRESENT' | 'LATE' | 'EARLY_LEAVE' | 'ON_TIME';
}

export function snapshotOfficeModel(office: Office) {
  return {
    id: office.id,
    code: office.code,
    name: office.name,
    latitude: office.latitude,
    longitude: office.longitude,
    radius_m: office.radius_m,
    max_gps_accuracy_m: office.max_gps_accuracy_m,
    max_location_age_s: office.max_location_age_s,
    timezone: office.timezone,
  };
}

export interface AttendanceAttempt {
  id: string;
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  purpose: 'CHECK_IN' | 'CHECK_OUT';
  received_at: string;
  status: 'PROCESSING' | 'ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED' | 'ERROR';
  reason_code: string | null;
  http_status: number | null;
  response: unknown;
  completed_at: string | null;
}

export async function findUserCategoryAndActive(db: Db, userId: string) {
  return db.query<{ employee_category_code: string | null; active: boolean }>(
    'SELECT employee_category_code,active FROM users WHERE id=$1',
    [userId],
  );
}

export async function findWorkScheduleForDate(db: Db, userId: string, date: Date) {
  return db.query<{
    id: string;
    starts_at: string;
    ends_at: string;
    grace_minutes: number;
  }>(
    `SELECT * FROM work_schedules WHERE user_id=$1 AND work_date=($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date`,
    [userId, date],
  );
}

export async function findExistingAttendances(db: Db, userId: string, scheduleId: string) {
  return db.query<{ type: string; office_id: string }>(
    'SELECT type,office_id FROM attendances WHERE user_id=$1 AND schedule_id=$2',
    [userId, scheduleId],
  );
}

export async function findAttendanceAttemptForUpdate(db: Db, userId: string, key: string) {
  return db.query<AttendanceAttempt>(
    'SELECT * FROM attendance_attempts WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',
    [userId, key],
  );
}

export async function insertAttendanceAttempt(
  db: Db,
  userId: string,
  key: string,
  digest: string,
  purpose: string,
  received: Date,
) {
  return db.query<{ id: string }>(
    `INSERT INTO attendance_attempts(user_id,idempotency_key,request_hash,purpose,received_at) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [userId, key, digest, purpose, received],
  );
}

export async function updateAttemptExpired(db: Db, attemptId: string, response: unknown) {
  return db.query(
    "UPDATE attendance_attempts SET status='ERROR',reason_code='PROCESSING_EXPIRED',http_status=503,response=$2,completed_at=now() WHERE id=$1",
    [attemptId, response],
  );
}

export async function countRecentRejectedAttempts(db: Db, userId: string) {
  return db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM attendance_attempts WHERE user_id=$1 AND status='REJECTED' AND received_at>now()-interval '15 minutes'",
    [userId],
  );
}

export async function findAttemptStatusForUpdate(db: Db, attemptId: string) {
  return db.query<{ status: string }>(
    'SELECT status FROM attendance_attempts WHERE id=$1 FOR UPDATE',
    [attemptId],
  );
}

export async function updateAttemptReview(db: Db, attemptId: string, response: unknown) {
  return db.query(
    "UPDATE attendance_attempts SET status='NEEDS_REVIEW',reason_code='FACE_REVIEW_REQUIRED',http_status=202,response=$2,completed_at=now() WHERE id=$1",
    [attemptId, response],
  );
}

export async function insertAttendanceRecord(
  db: Db,
  record: {
    userId: string;
    scheduleId: string;
    attemptId: string;
    officeId: string;
    deviceId: string;
    purpose: string;
    received: Date;
    category: string;
    officeSnapshot: unknown;
    latitude: number;
    longitude: number;
    accuracy_m: number;
    distance_m: number;
    score: number;
    liveness_score: number;
    model_version: string;
    policySnapshot: unknown;
    status: string;
  },
) {
  return db.query<{
    id: string;
    type: string;
    server_time: Date;
    status: string;
    office_id: string;
    distance_m: number;
  }>(
    `INSERT INTO attendances(user_id,schedule_id,attempt_id,office_id,device_id,type,server_time,employee_category_at_event,
    office_snapshot,latitude,longitude,gps_accuracy,distance_m,face_score,liveness_score,model_version,policy_snapshot,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id,type,server_time,status,office_id,distance_m`,
    [
      record.userId,
      record.scheduleId,
      record.attemptId,
      record.officeId,
      record.deviceId,
      record.purpose,
      record.received,
      record.category,
      record.officeSnapshot,
      record.latitude,
      record.longitude,
      record.accuracy_m,
      record.distance_m,
      record.score,
      record.liveness_score,
      record.model_version,
      record.policySnapshot,
      record.status,
    ],
  );
}

export async function updateAttemptAccepted(db: Db, attemptId: string, response: unknown) {
  return db.query(
    "UPDATE attendance_attempts SET status='ACCEPTED',http_status=201,response=$2,completed_at=now() WHERE id=$1",
    [attemptId, response],
  );
}

export async function updateAttemptFailed(
  db: Db,
  attemptId: string,
  status: 'ERROR' | 'REJECTED',
  code: string,
  httpStatus: number,
  response: unknown,
) {
  return db.query<{ id: string }>(
    `UPDATE attendance_attempts SET status=$2,reason_code=$3,http_status=$4,response=$5,completed_at=now()
    WHERE id=$1 AND status='PROCESSING' RETURNING id`,
    [attemptId, status, code, httpStatus, response],
  );
}

export async function findAttemptResponse(db: Db, attemptId: string) {
  return db.query<{ http_status: number | null; response: unknown }>(
    'SELECT http_status,response FROM attendance_attempts WHERE id=$1',
    [attemptId],
  );
}

export async function findAttendanceAttemptByIdAndUser(db: Db, id: string, userId: string) {
  return db.query<{
    id: string;
    status: string;
    reason_code: string | null;
    received_at: string;
    completed_at: string | null;
    response: unknown;
  }>(
    'SELECT id,status,reason_code,received_at,completed_at,response FROM attendance_attempts WHERE id=$1 AND user_id=$2',
    [id, userId],
  );
}

export async function findAttendanceHistory(
  db: Db,
  userId: string,
  from: string,
  to: string,
  limit: number,
  offset: number,
) {
  return db.query<{
    id: string;
    type: string;
    server_time: string;
    status: string;
    office_snapshot: unknown;
    distance_m: number;
    employee_category_at_event: string;
  }>(
    `SELECT id,type,server_time,status,office_snapshot,distance_m,employee_category_at_event FROM attendances
    WHERE user_id=$1 AND server_time >= ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta')
    AND server_time < (($3::date+1)::timestamp AT TIME ZONE 'Asia/Jakarta') ORDER BY server_time DESC LIMIT $4 OFFSET $5`,
    [userId, from, to, limit, offset],
  );
}
