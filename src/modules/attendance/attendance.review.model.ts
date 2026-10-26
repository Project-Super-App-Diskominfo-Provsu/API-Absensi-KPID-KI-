import type { Db } from '../../database/client.js';
import { queryPage } from '../../database/page.js';
import type { z } from 'zod';
import type { attendanceReviewQuery, ReviewEvidence } from './attendance.review.schema.js';

export interface ReviewAttempt {
  id: string;
  user_id: string;
  purpose: 'CHECK_IN' | 'CHECK_OUT';
  received_at: Date;
  attempt_status: string;
  review_status: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  employee_category_at_event: string | null;
  evidence: unknown;
}

export function saveReviewEvidence(db: Db, id: string, category: string, evidence: ReviewEvidence) {
  return db.query(
    'INSERT INTO attendance_reviews(attempt_id,employee_category_at_event,evidence) VALUES($1,$2,$3)',
    [id, category, evidence],
  );
}

export function findReviewAttempt(db: Db, id: string) {
  return db.query<ReviewAttempt>(
    `SELECT a.id,a.user_id,a.purpose,a.received_at,a.status AS attempt_status,
      r.status AS review_status,r.employee_category_at_event,r.evidence,
      r.reviewed_by,r.reviewed_at,r.reason,r.identity_verified
     FROM attendance_attempts a LEFT JOIN attendance_reviews r ON r.attempt_id=a.id WHERE a.id=$1`,
    [id],
  );
}

export function listReviews(
  db: Db,
  superAdmin: boolean,
  category: string | null,
  query: z.infer<typeof attendanceReviewQuery>,
) {
  return queryPage(
    db,
    `SELECT a.id AS attempt_id,a.user_id,u.name,u.employee_number,a.purpose,a.received_at,
      a.status AS attempt_status,COALESCE(r.status,'PENDING') AS review_status,
      r.employee_category_at_event,r.evidence,r.reviewed_by,r.reviewed_at,r.reason,r.identity_verified,
      (r.evidence IS NOT NULL) AS evidence_available
     FROM attendance_attempts a JOIN users u ON u.id=a.user_id
     LEFT JOIN attendance_reviews r ON r.attempt_id=a.id
     WHERE (($3='PENDING' AND a.status='NEEDS_REVIEW' AND (r.status IS NULL OR r.status='PENDING')) OR r.status=$3)
       AND ($1::boolean OR (u.employee_category_code=$2 AND r.employee_category_at_event=$2
         AND u.role IN ('EMPLOYEE','VERIFIER')))
       AND ($4::uuid IS NULL OR a.user_id=$4)`,
    [superAdmin, category, query.status, query.user_id ?? null],
    'received_at DESC,attempt_id DESC',
    query.limit,
    query.offset,
  );
}

export async function finishReview(
  db: Db,
  attempt: ReviewAttempt,
  actor: string,
  status: string,
  reason: string,
  verified: boolean,
) {
  if (attempt.review_status !== null) {
    return db.query(
      `UPDATE attendance_reviews SET status=$2,reviewed_by=$3,reviewed_at=now(),reason=$4,identity_verified=$5
       WHERE attempt_id=$1 AND status='PENDING'`,
      [attempt.id, status, actor, reason, verified],
    );
  }
  return db.query(
    `INSERT INTO attendance_reviews(attempt_id,status,reviewed_by,reviewed_at,reason,identity_verified)
     VALUES($1,$2,$3,now(),$4,$5)`,
    [attempt.id, status, actor, reason, verified],
  );
}
