import type { Db } from '../../database/client.js';

export type LeaveCategory = 'SAKIT' | 'IZIN' | 'CUTI' | 'DINAS_LUAR';
export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequest {
  id: string;
  user_id: string;
  category: LeaveCategory;
  start_date: string;
  end_date: string;
  notes: string;
  attachment_url?: string | null;
  status: LeaveStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_notes?: string | null;
  created_at: string;
  updated_at: string;
  user_name?: string;
  employee_number?: string;
  employee_category_code?: string;
}

export async function insertLeaveRequest(
  db: Db,
  input: {
    user_id: string;
    category: LeaveCategory;
    start_date: string;
    end_date: string;
    notes: string;
    attachment_url?: string;
  },
) {
  return db.query<LeaveRequest>(
    `INSERT INTO leave_requests(user_id,category,start_date,end_date,notes,attachment_url)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING id,user_id,category,start_date::text,end_date::text,notes,attachment_url,status,reviewed_by,reviewed_at,review_notes,created_at,updated_at`,
    [
      input.user_id,
      input.category,
      input.start_date,
      input.end_date,
      input.notes,
      input.attachment_url ?? null,
    ],
  );
}

export async function findOverlappingLeave(
  db: Db,
  userId: string,
  startDate: string,
  endDate: string,
) {
  return db.query<LeaveRequest>(
    `SELECT id,status,start_date::text,end_date::text FROM leave_requests
     WHERE user_id=$1 AND status IN ('PENDING','APPROVED')
       AND NOT (end_date < $2::date OR start_date > $3::date)
     LIMIT 1`,
    [userId, startDate, endDate],
  );
}

export async function findLeaveRequestById(db: Db, id: string, forUpdate = false) {
  return db.query<LeaveRequest>(
    `SELECT l.id,l.user_id,l.category,l.start_date::text,l.end_date::text,l.notes,l.attachment_url,l.status,
            l.reviewed_by,l.reviewed_at,l.review_notes,l.created_at,l.updated_at,
            u.name as user_name,u.employee_number,u.employee_category_code
     FROM leave_requests l JOIN users u ON u.id=l.user_id
     WHERE l.id=$1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
}

export async function findLeaveRequestsByUser(
  db: Db,
  userId: string,
  from?: string,
  to?: string,
  status?: string,
  limit = 25,
  offset = 0,
) {
  const conditions = ['l.user_id=$1'];
  const values: unknown[] = [userId];
  if (from) {
    values.push(from);
    conditions.push(`l.end_date >= $${values.length}::date`);
  }
  if (to) {
    values.push(to);
    conditions.push(`l.start_date <= $${values.length}::date`);
  }
  if (status) {
    values.push(status);
    conditions.push(`l.status = $${values.length}`);
  }

  const where = conditions.join(' AND ');
  const countRes = await db.query<{ count: string }>(
    `SELECT count(*) FROM leave_requests l WHERE ${where}`,
    values,
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  values.push(limit, offset);
  const dataRes = await db.query<LeaveRequest>(
    `SELECT l.id,l.user_id,l.category,l.start_date::text,l.end_date::text,l.notes,l.attachment_url,l.status,
            l.reviewed_by,l.reviewed_at,l.review_notes,l.created_at,l.updated_at
     FROM leave_requests l
     WHERE ${where}
     ORDER BY l.start_date DESC, l.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { data: dataRes.rows, meta: { limit, offset, total } };
}

export async function findAdminLeaveRequests(
  db: Db,
  filter: {
    categoryCode?: string | null;
    status?: string;
    from?: string;
    to?: string;
    userId?: string;
  },
  limit = 25,
  offset = 0,
) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.categoryCode) {
    values.push(filter.categoryCode);
    conditions.push(`u.employee_category_code = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`l.status = $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    conditions.push(`l.end_date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    conditions.push(`l.start_date <= $${values.length}::date`);
  }
  if (filter.userId) {
    values.push(filter.userId);
    conditions.push(`l.user_id = $${values.length}`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRes = await db.query<{ count: string }>(
    `SELECT count(*) FROM leave_requests l JOIN users u ON u.id=l.user_id ${where}`,
    values,
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  values.push(limit, offset);
  const dataRes = await db.query<LeaveRequest>(
    `SELECT l.id,l.user_id,l.category,l.start_date::text,l.end_date::text,l.notes,l.attachment_url,l.status,
            l.reviewed_by,l.reviewed_at,l.review_notes,l.created_at,l.updated_at,
            u.name as user_name,u.employee_number,u.employee_category_code
     FROM leave_requests l JOIN users u ON u.id=l.user_id
     ${where}
     ORDER BY l.start_date DESC, l.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { data: dataRes.rows, meta: { limit, offset, total } };
}

export async function updateLeaveRequestStatus(
  db: Db,
  id: string,
  reviewerId: string,
  status: 'APPROVED' | 'REJECTED',
  reviewNotes?: string,
) {
  return db.query<LeaveRequest>(
    `UPDATE leave_requests
     SET status=$2,reviewed_by=$3,reviewed_at=now(),review_notes=$4,updated_at=now()
     WHERE id=$1
     RETURNING id,user_id,category,start_date::text,end_date::text,notes,attachment_url,status,reviewed_by,reviewed_at,review_notes,created_at,updated_at`,
    [id, status, reviewerId, reviewNotes ?? null],
  );
}

export async function cancelLeaveRequest(db: Db, id: string, userId: string) {
  return db.query<LeaveRequest>(
    `UPDATE leave_requests
     SET status='CANCELLED',updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status='PENDING'
     RETURNING id,user_id,category,start_date::text,end_date::text,notes,attachment_url,status,created_at,updated_at`,
    [id, userId],
  );
}
