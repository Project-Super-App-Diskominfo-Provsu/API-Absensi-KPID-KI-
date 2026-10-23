import type { Db } from '../../database/client.js';
import { userFields, type User } from '../auth/auth.model.js';
import { queryPage } from '../../database/page.js';
import type { z } from 'zod';
import type {
  userListQuerySchema,
  adminScheduleQuerySchema,
  adminAttendanceQuerySchema,
} from './admin.schema.js';

export interface Unit {
  id: string;
  name: string;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_id: string;
  action: string;
  target_id: string;
  detail: unknown;
  created_at: string;
}

export interface WorkSchedule {
  id: string;
  user_id: string;
  work_date: string;
  starts_at: string;
  ends_at: string;
  grace_minutes: number;
}

export async function findUserForUpdate(db: Db, id: string) {
  return db.query<User>(`SELECT ${userFields} FROM users WHERE id=$1 FOR UPDATE`, [id]);
}

export async function findUserFaceTemplates(db: Db, userId: string) {
  return db.query<{ status: string; model_version: string }>(
    "SELECT status,model_version FROM face_templates WHERE user_id=$1 AND status IN ('ACTIVE','PENDING') ORDER BY created_at DESC",
    [userId],
  );
}

export async function findUsersPaginated(
  db: Db,
  isSuperAdmin: boolean,
  categoryCode: string | null,
  query: z.infer<typeof userListQuerySchema>,
) {
  return queryPage<User>(
    db,
    `SELECT ${userFields},created_at FROM users WHERE ($1::boolean OR (employee_category_code=$2 AND role IN ('EMPLOYEE','VERIFIER')))
    AND ($3::text IS NULL OR name ILIKE $3 OR employee_number ILIKE $3 OR email ILIKE $3)
    AND ($4::text IS NULL OR employee_category_code=$4) AND ($5::text IS NULL OR role=$5) AND ($6::boolean IS NULL OR active=$6)`,
    [
      isSuperAdmin,
      categoryCode,
      query.q ? '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%' : null,
      query.employee_category_code ?? null,
      query.role ?? null,
      query.active ?? null,
    ],
    'created_at DESC,id DESC',
    query.limit,
    query.offset,
  );
}

export function findAdminAttendance(
  db: Db,
  actor: User,
  query: z.infer<typeof adminAttendanceQuerySchema>,
) {
  return queryPage(
    db,
    `SELECT a.id,a.user_id,u.name,u.employee_number,a.schedule_id,a.office_id,a.type,a.server_time,a.status,a.office_snapshot,a.distance_m,a.employee_category_at_event
    FROM attendances a JOIN users u ON u.id=a.user_id
    WHERE ($1::boolean OR (u.employee_category_code=$2 AND a.employee_category_at_event=$2 AND u.role IN ('EMPLOYEE','VERIFIER')))
    AND a.server_time>=($3::date::timestamp AT TIME ZONE 'Asia/Jakarta') AND a.server_time<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Jakarta')
    AND ($5::uuid IS NULL OR a.user_id=$5) AND ($6::uuid IS NULL OR a.office_id=$6)
    AND ($7::text IS NULL OR a.type=$7) AND ($8::text IS NULL OR a.status=$8)`,
    [
      actor.role === 'SUPER_ADMIN',
      actor.employee_category_code,
      query.from,
      query.to,
      query.user_id ?? null,
      query.office_id ?? null,
      query.type ?? null,
      query.status ?? null,
    ],
    'server_time DESC,id DESC',
    query.limit,
    query.offset,
  );
}

export function findAdminSchedules(
  db: Db,
  actor: User,
  query: z.infer<typeof adminScheduleQuerySchema>,
) {
  return queryPage(
    db,
    `SELECT s.id,s.user_id,u.name,u.employee_number,s.work_date::text,s.starts_at,s.ends_at,s.grace_minutes FROM work_schedules s JOIN users u ON u.id=s.user_id
    WHERE ($1::boolean OR (u.employee_category_code=$2 AND u.role IN ('EMPLOYEE','VERIFIER'))) AND s.work_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR s.user_id=$5)`,
    [
      actor.role === 'SUPER_ADMIN',
      actor.employee_category_code,
      query.from,
      query.to,
      query.user_id ?? null,
    ],
    'work_date DESC,id DESC',
    query.limit,
    query.offset,
  );
}

export function findScheduleById(db: Db, id: string, lock = false) {
  return db.query<WorkSchedule>(
    `SELECT id,user_id,work_date::text,starts_at,ends_at,grace_minutes FROM work_schedules WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
}

export function findScheduleAttendance(db: Db, id: string) {
  return db.query('SELECT 1 FROM attendances WHERE schedule_id=$1 LIMIT 1', [id]);
}

export function updateSchedule(
  db: Db,
  id: string,
  data: { work_date: string; starts_at: string; ends_at: string; grace_minutes: number },
) {
  return db.query(
    'UPDATE work_schedules SET work_date=$2,starts_at=$3,ends_at=$4,grace_minutes=$5 WHERE id=$1 RETURNING id,user_id,work_date::text,starts_at,ends_at,grace_minutes',
    [id, data.work_date, data.starts_at, data.ends_at, data.grace_minutes],
  );
}

export async function insertUser(
  db: Db,
  data: {
    employee_number: string;
    name: string;
    email: string;
    password_hash: string;
    role: string;
    employee_category_code: string;
    unit_id: string | null;
    active: boolean;
  },
) {
  return db.query<User>(
    `INSERT INTO users(employee_number,name,email,password_hash,role,employee_category_code,unit_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${userFields}`,
    [
      data.employee_number,
      data.name,
      data.email,
      data.password_hash,
      data.role,
      data.employee_category_code,
      data.unit_id,
      data.active,
    ],
  );
}

export async function updateUserFields(db: Db, id: string, fields: Record<string, unknown>) {
  const values = Object.values(fields);
  const set = Object.keys(fields)
    .map((k, i) => `${k}=$${i + 2}`)
    .join(',');
  return db.query<User>(`UPDATE users SET ${set} WHERE id=$1 RETURNING ${userFields}`, [
    id,
    ...values,
  ]);
}

export async function revokeUserSessions(db: Db, userId: string) {
  return db.query(
    'UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',
    [userId],
  );
}

export async function findAllUnits(db: Db) {
  return db.query<Unit>('SELECT * FROM units ORDER BY name');
}

export async function insertUnit(db: Db, name: string) {
  return db.query<Unit>('INSERT INTO units(name) VALUES($1) RETURNING *', [name]);
}

export async function findAuditLogs(db: Db, limit: number, offset: number) {
  return queryPage<AuditLog>(
    db,
    'SELECT id,actor_id,action,target_id,detail,created_at FROM audit_logs',
    [],
    'id DESC',
    limit,
    offset,
  );
}

export async function insertWorkSchedule(
  db: Db,
  data: {
    user_id: string;
    work_date: string;
    starts_at: string;
    ends_at: string;
    grace_minutes: number;
  },
) {
  return db.query<WorkSchedule>(
    'INSERT INTO work_schedules(user_id,work_date,starts_at,ends_at,grace_minutes) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [data.user_id, data.work_date, data.starts_at, data.ends_at, data.grace_minutes],
  );
}

export async function findWorkSchedulesByUserAndRange(
  db: Db,
  userId: string,
  from: string,
  to: string,
) {
  return db.query<WorkSchedule>(
    'SELECT * FROM work_schedules WHERE user_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date LIMIT 100',
    [userId, from, to],
  );
}

export async function insertWorkSchedulesBatch(
  db: Db,
  rows: Array<{
    user_id: string;
    work_date: string;
    starts_at: string;
    ends_at: string;
    grace_minutes: number;
  }>,
) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (const row of rows) {
    const res = await db.query(
      'INSERT INTO work_schedules(user_id,work_date,starts_at,ends_at,grace_minutes) VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id,work_date) DO NOTHING',
      [row.user_id, row.work_date, row.starts_at, row.ends_at, row.grace_minutes],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export async function findManagedActiveUsers(db: Db, categoryCode: string | null) {
  if (categoryCode) {
    return db.query<{ id: string }>(
      "SELECT id FROM users WHERE active AND employee_category_code=$1 AND role IN ('EMPLOYEE','VERIFIER')",
      [categoryCode],
    );
  }
  return db.query<{ id: string }>(
    "SELECT id FROM users WHERE active AND role IN ('EMPLOYEE','VERIFIER')",
  );
}
