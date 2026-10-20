import type { Db } from '../../database/client.js';
import { userFields, type User } from '../auth/auth.model.js';

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
  limit: number,
  offset: number,
) {
  return db.query<User>(
    `SELECT ${userFields} FROM users WHERE ($1::boolean OR (employee_category_code=$2 AND role IN ('EMPLOYEE','VERIFIER'))) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [isSuperAdmin, categoryCode, limit, offset],
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
  return db.query<AuditLog>('SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2', [
    limit,
    offset,
  ]);
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
