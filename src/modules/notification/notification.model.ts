import type { Db } from '../../database/client.js';
import { hash } from '../../shared/security/crypto.js';

export async function mobileSessionFamily(db: Db, userId: string, sessionId: string) {
  return db.query<{ family_id: string }>(
    "SELECT family_id FROM refresh_sessions WHERE id=$1 AND user_id=$2 AND client_type='MOBILE' AND revoked_at IS NULL AND expires_at>now()",
    [sessionId, userId],
  );
}
export async function savePushToken(
  db: Db,
  deviceId: string,
  family: string,
  project: string,
  token: string,
) {
  await db.query(
    `INSERT INTO device_push_tokens(device_id,session_family_id,project_id,token,token_hash) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(device_id) DO UPDATE SET session_family_id=EXCLUDED.session_family_id,
      project_id=EXCLUDED.project_id,token=EXCLUDED.token,token_hash=EXCLUDED.token_hash,updated_at=now()`,
    [deviceId, family, project, token, hash(token)],
  );
}
export async function removePushToken(db: Db, deviceId: string, userId: string) {
  await db.query(
    'DELETE FROM device_push_tokens p USING devices d WHERE p.device_id=d.id AND d.id=$1 AND d.user_id=$2',
    [deviceId, userId],
  );
}

export async function enqueueReminders(db: Db, project: string, now: Date) {
  await db.query(`UPDATE notification_deliveries n SET
    due_at=s.starts_at+make_interval(mins=>s.grace_minutes)-interval '5 minutes',
    expires_at=s.starts_at+make_interval(mins=>s.grace_minutes),
    next_attempt_at=CASE WHEN n.attempts=0 THEN s.starts_at+make_interval(mins=>s.grace_minutes)-interval '5 minutes'
      ELSE GREATEST(n.next_attempt_at,s.starts_at+make_interval(mins=>s.grace_minutes)-interval '5 minutes') END
    FROM work_schedules s WHERE n.schedule_id=s.id AND n.status='PENDING'
      AND n.expires_at IS DISTINCT FROM s.starts_at+make_interval(mins=>s.grace_minutes)`);
  await db.query(
    `INSERT INTO notification_deliveries(schedule_id,due_at,expires_at,next_attempt_at)
    SELECT s.id,s.starts_at+make_interval(mins=>s.grace_minutes)-interval '5 minutes',
      s.starts_at+make_interval(mins=>s.grace_minutes),
      s.starts_at+make_interval(mins=>s.grace_minutes)-interval '5 minutes'
    FROM work_schedules s JOIN users u ON u.id=s.user_id
    JOIN devices d ON d.user_id=u.id AND d.status='ACTIVE'
    JOIN device_push_tokens p ON p.device_id=d.id AND p.project_id=$1
    WHERE u.active AND u.role IN ('EMPLOYEE','VERIFIER') AND u.employee_category_code IN ('KPID','KI')
      AND s.work_date=($2::timestamptz AT TIME ZONE 'Asia/Jakarta')::date
      AND s.starts_at+make_interval(mins=>s.grace_minutes)>$2
      AND EXISTS(SELECT 1 FROM refresh_sessions r WHERE r.user_id=u.id AND r.family_id=p.session_family_id
        AND r.client_type='MOBILE' AND r.revoked_at IS NULL AND r.expires_at>$2)
      AND NOT EXISTS(SELECT 1 FROM attendances a WHERE a.user_id=u.id AND a.schedule_id=s.id AND a.type='CHECK_IN')
      AND NOT EXISTS(SELECT 1 FROM holidays h WHERE h.holiday_date=s.work_date)
      AND NOT EXISTS(SELECT 1 FROM leave_requests l WHERE l.user_id=u.id AND l.status='APPROVED' AND s.work_date BETWEEN l.start_date AND l.end_date)
    ON CONFLICT(schedule_id,kind) DO UPDATE SET due_at=EXCLUDED.due_at,expires_at=EXCLUDED.expires_at,
      next_attempt_at=CASE WHEN notification_deliveries.attempts=0 THEN EXCLUDED.due_at
        ELSE GREATEST(notification_deliveries.next_attempt_at,EXCLUDED.due_at) END
    WHERE notification_deliveries.status='PENDING'`,
    [project, now],
  );
  await db.query(
    `UPDATE notification_deliveries SET status=CASE WHEN expires_at<=$1 THEN 'SKIPPED' ELSE 'FAILED' END,
    last_error=CASE WHEN expires_at<=$1 THEN 'EXPIRED' ELSE 'RETRIES_EXHAUSTED' END,claim_id=NULL,lease_until=NULL
    WHERE (status='PENDING' OR (status='PROCESSING' AND lease_until<=$1))
      AND (expires_at<=$1 OR attempts>=3)`,
    [now],
  );
}

export interface Delivery {
  id: string;
  schedule_id: string;
  attempts: number;
  claim_id: string;
}
export async function claimReminder(db: Db, now: Date) {
  return db.query<Delivery>(
    `WITH candidate AS (
    SELECT id FROM notification_deliveries
    WHERE status IN ('PENDING','PROCESSING') AND next_attempt_at<=$1 AND attempts<3
      AND (status='PENDING' OR lease_until<=$1)
    ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE notification_deliveries n SET status='PROCESSING',attempts=n.attempts+1,
    claim_id=gen_random_uuid(),lease_until=$1::timestamptz+interval '2 minutes'
  FROM candidate c WHERE n.id=c.id RETURNING n.id,n.schedule_id,n.attempts,n.claim_id`,
    [now],
  );
}

export interface ReminderContext {
  active: boolean;
  role: string;
  employee_category_code: string | null;
  deadline: Date;
  checked_in: boolean;
  on_holiday: boolean;
  on_leave: boolean;
  device_id: string | null;
  token: string | null;
  session_active: boolean;
}
export async function reminderContext(db: Db, scheduleId: string, project: string, now: Date) {
  return db.query<ReminderContext>(
    `SELECT u.active,u.role,u.employee_category_code,
      s.starts_at+make_interval(mins=>s.grace_minutes) AS deadline,
      EXISTS(SELECT 1 FROM attendances a WHERE a.user_id=u.id AND a.schedule_id=s.id AND a.type='CHECK_IN') AS checked_in,
      EXISTS(SELECT 1 FROM holidays h WHERE h.holiday_date=s.work_date) AS on_holiday,
      EXISTS(SELECT 1 FROM leave_requests l WHERE l.user_id=u.id AND l.status='APPROVED'
        AND s.work_date BETWEEN l.start_date AND l.end_date) AS on_leave,
      d.id AS device_id,p.token,
      EXISTS(SELECT 1 FROM refresh_sessions r WHERE r.user_id=u.id AND r.family_id=p.session_family_id
        AND r.client_type='MOBILE' AND r.revoked_at IS NULL AND r.expires_at>$3) AS session_active
    FROM work_schedules s JOIN users u ON u.id=s.user_id
    LEFT JOIN devices d ON d.user_id=u.id AND d.status='ACTIVE'
    LEFT JOIN device_push_tokens p ON p.device_id=d.id AND p.project_id=$2
    WHERE s.id=$1`,
    [scheduleId, project, now],
  );
}
export async function finishReminder(
  db: Db,
  delivery: Delivery,
  status: 'SENT' | 'SKIPPED' | 'FAILED',
  reason: string | null,
  now: Date,
) {
  await db.query(
    `UPDATE notification_deliveries SET status=$3,last_error=$4,claim_id=NULL,lease_until=NULL,
    sent_at=CASE WHEN $3='SENT' THEN $5::timestamptz ELSE NULL END
    WHERE id=$1 AND claim_id=$2 AND status='PROCESSING'`,
    [delivery.id, delivery.claim_id, status, reason, now],
  );
}
export async function retryReminder(
  db: Db,
  delivery: Delivery,
  retryAt: Date,
  deadline: Date,
  reason: string,
  undoAttempt = false,
) {
  await db.query(
    `UPDATE notification_deliveries SET status='PENDING',next_attempt_at=$3,due_at=LEAST(due_at,$3),
    expires_at=$4,last_error=$5,claim_id=NULL,lease_until=NULL,attempts=attempts-$6
    WHERE id=$1 AND claim_id=$2 AND status='PROCESSING'`,
    [delivery.id, delivery.claim_id, retryAt, deadline, reason, undoAttempt ? 1 : 0],
  );
}
export async function discardInvalidToken(db: Db, deviceId: string, token: string) {
  await db.query('DELETE FROM device_push_tokens WHERE device_id=$1 AND token=$2', [
    deviceId,
    token,
  ]);
}

export async function renewReminderLease(db: Db, delivery: Delivery, now: Date) {
  await db.query(
    `UPDATE notification_deliveries SET lease_until=$3::timestamptz+interval '2 minutes'
    WHERE id=$1 AND claim_id=$2 AND status='PROCESSING'`,
    [delivery.id, delivery.claim_id, now],
  );
}
