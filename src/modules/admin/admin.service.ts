import { hashPassword } from '../../shared/security/password.js';
import type { Pool } from 'pg';
import { audit } from '../../database/audit.js';
import { transaction, type Db } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import type { User } from '../auth/auth.model.js';
import {
  findUserForUpdate,
  findUserFaceTemplates,
  findUsersPaginated,
  insertUser,
  updateUserFields,
  revokeUserSessions,
  findAllUnits,
  insertUnit,
  findAuditLogs,
  insertWorkSchedule,
  findWorkSchedulesByUserAndRange,
  insertWorkSchedulesBatch,
  findManagedActiveUsers,
  findAdminAttendance,
  findAdminSchedules,
  findScheduleById,
  findScheduleAttendance,
  updateSchedule,
} from './admin.model.js';
import { getDefaultWorkHours, isWeekend } from './admin.schedule-policy.js';
import {
  scheduleSchema,
  type userListQuerySchema,
  type adminScheduleQuerySchema,
  type adminAttendanceQuerySchema,
  type patchScheduleSchema,
} from './admin.schema.js';
import type { z } from 'zod';

export async function managedUser(db: Db, actor: User, id: string): Promise<User> {
  const row = await findUserForUpdate(db, id);
  const user = row.rows[0];
  if (!user) fail(404, 'NOT_FOUND', 'Pegawai tidak ditemukan.');

  if (
    actor.role !== 'SUPER_ADMIN' &&
    (user.employee_category_code !== actor.employee_category_code ||
      !actor.employee_category_code ||
      !['EMPLOYEE', 'VERIFIER'].includes(user.role))
  ) {
    fail(403, 'FORBIDDEN', 'Pegawai di luar kewenangan admin.');
  }

  return user;
}

export async function getMeProfile(pool: Db, user: User) {
  const face = await findUserFaceTemplates(pool, user.id);
  return { ...user, face_enrollments: face.rows };
}

export async function listUsers(
  pool: Pool,
  actor: User,
  query: z.infer<typeof userListQuerySchema>,
) {
  return findUsersPaginated(
    pool,
    actor.role === 'SUPER_ADMIN',
    actor.employee_category_code,
    query,
  );
}

export async function getManagedProfile(pool: Pool, actor: User, id: string) {
  return transaction(pool, async (db) => getMeProfile(db, await managedUser(db, actor, id)));
}
export function listAdminAttendance(
  pool: Pool,
  actor: User,
  query: z.infer<typeof adminAttendanceQuerySchema>,
) {
  return findAdminAttendance(pool, actor, query);
}
export function listAdminSchedules(
  pool: Pool,
  actor: User,
  query: z.infer<typeof adminScheduleQuerySchema>,
) {
  return findAdminSchedules(pool, actor, query);
}
export async function patchSchedule(
  pool: Pool,
  actor: User,
  id: string,
  input: z.infer<typeof patchScheduleSchema>,
) {
  return transaction(pool, async (db) => {
    const initial = await findScheduleById(db, id);
    if (!initial.rowCount) fail(404, 'NOT_FOUND', 'Jadwal tidak ditemukan.');
    await managedUser(db, actor, initial.rows[0]!.user_id);
    const current = (await findScheduleById(db, id, true)).rows[0]!;
    if ((await findScheduleAttendance(db, id)).rowCount)
      fail(409, 'SCHEDULE_LOCKED', 'Jadwal sudah digunakan untuk absensi dan tidak dapat diubah.');
    const { reason, ...fields } = input;
    const merged = {
      ...current,
      starts_at: new Date(current.starts_at).toISOString(),
      ends_at: new Date(current.ends_at).toISOString(),
      ...fields,
    };
    const validated = scheduleSchema.parse({
      user_id: current.user_id,
      work_date: merged.work_date,
      starts_at: merged.starts_at,
      ends_at: merged.ends_at,
      grace_minutes: merged.grace_minutes,
    });
    const updated = await updateSchedule(db, id, validated);
    await audit(db, actor.id, 'SCHEDULE_UPDATED', id, {
      reason,
      before: current,
      after: updated.rows[0],
    });
    return updated.rows[0];
  });
}

export async function createUser(
  pool: Pool,
  actor: User,
  input: {
    employee_number: string;
    name: string;
    email: string;
    password: string;
    role: 'EMPLOYEE' | 'VERIFIER' | 'ADMIN' | 'SUPER_ADMIN';
    employee_category_code: 'KPID' | 'KI';
    unit_id: string | null;
    active: boolean;
  },
) {
  if (
    actor.role !== 'SUPER_ADMIN' &&
    (input.employee_category_code !== actor.employee_category_code ||
      !['EMPLOYEE', 'VERIFIER'].includes(input.role))
  ) {
    fail(403, 'FORBIDDEN', 'Kategori atau peran di luar kewenangan.');
  }

  const passwordHash = await hashPassword(input.password);
  return transaction(pool, async (db) => {
    const created = await insertUser(db, {
      employee_number: input.employee_number,
      name: input.name,
      email: input.email,
      password_hash: passwordHash,
      role: input.role,
      employee_category_code: input.employee_category_code,
      unit_id: input.unit_id,
      active: input.active,
    });

    await audit(db, actor.id, 'USER_CREATED', created.rows[0]!.id, {
      category: input.employee_category_code,
      role: input.role,
    });

    return created.rows[0]!;
  });
}

export async function updateUser(
  pool: Pool,
  actor: User,
  id: string,
  input: Record<string, unknown>,
) {
  if (id === actor.id) {
    fail(403, 'SELF_UPDATE_FORBIDDEN', 'Gunakan admin lain untuk mengubah akses akun sendiri.');
  }

  if (
    actor.role !== 'SUPER_ADMIN' &&
    (input.auth_mode !== undefined ||
      input.google_email_linking_allowed !== undefined ||
      (input.employee_category_code &&
        input.employee_category_code !== actor.employee_category_code) ||
      (input.role && !['EMPLOYEE', 'VERIFIER'].includes(input.role as string)))
  ) {
    fail(403, 'FORBIDDEN', 'Perubahan di luar kewenangan admin.');
  }

  return transaction(pool, async (db) => {
    const old = await managedUser(db, actor, id);
    const updated = await updateUserFields(db, id, input);

    if (
      input.active === false ||
      input.role !== undefined ||
      input.auth_mode !== undefined ||
      input.google_email_linking_allowed !== undefined
    ) {
      await revokeUserSessions(db, id);
    }

    await audit(db, actor.id, 'USER_UPDATED', id, { before: old, after: updated.rows[0]! });
    return updated.rows[0]!;
  });
}

export async function listUnits(pool: Pool) {
  const result = await findAllUnits(pool);
  return result.rows;
}

export async function createUnit(pool: Pool, actorId: string, name: string) {
  return transaction(pool, async (db) => {
    const created = await insertUnit(db, name);
    await audit(db, actorId, 'UNIT_CREATED', created.rows[0]!.id);
    return created.rows[0]!;
  });
}

export async function listAuditLogs(pool: Pool, limit: number, offset: number) {
  return findAuditLogs(pool, limit, offset);
}

export async function createSchedule(
  pool: Pool,
  actor: User,
  input: {
    user_id: string;
    work_date: string;
    starts_at: string;
    ends_at: string;
    grace_minutes: number;
  },
) {
  return transaction(pool, async (db) => {
    await managedUser(db, actor, input.user_id);
    const created = await insertWorkSchedule(db, input);
    await audit(db, actor.id, 'SCHEDULE_CREATED', created.rows[0]!.id);
    return created.rows[0]!;
  });
}

export async function listSchedules(pool: Pool, userId: string, from: string, to: string) {
  const result = await findWorkSchedulesByUserAndRange(pool, userId, from, to);
  return result.rows;
}

export async function generateSchedules(
  pool: Pool,
  actor: User,
  input: {
    user_id?: string;
    from: string;
    to: string;
    grace_minutes: number;
    skip_holidays: boolean;
  },
) {
  return transaction(pool, async (db) => {
    let targetUserIds: string[] = [];
    if (input.user_id) {
      await managedUser(db, actor, input.user_id);
      targetUserIds = [input.user_id];
    } else {
      const category = actor.role === 'SUPER_ADMIN' ? null : actor.employee_category_code;
      const managed = await findManagedActiveUsers(db, category);
      targetUserIds = managed.rows.map((r) => r.id);
    }

    if (!targetUserIds.length) {
      return { total_users: 0, generated_schedules: 0, skipped_days: 0 };
    }

    const holidayDates = new Set<string>();
    if (input.skip_holidays) {
      const holidays = await db.query<{ holiday_date: string }>(
        'SELECT holiday_date::text FROM holidays WHERE holiday_date BETWEEN $1 AND $2',
        [input.from, input.to],
      );
      for (const h of holidays.rows) {
        holidayDates.add(h.holiday_date);
      }
    }

    const rowsToInsert: Array<{
      user_id: string;
      work_date: string;
      starts_at: string;
      ends_at: string;
      grace_minutes: number;
    }> = [];

    let skippedDays = 0;
    const current = new Date(`${input.from}T12:00:00+07:00`);
    const end = new Date(`${input.to}T12:00:00+07:00`);

    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      if (isWeekend(dateStr) || holidayDates.has(dateStr)) {
        skippedDays++;
      } else {
        const hours = getDefaultWorkHours(dateStr);
        if (hours) {
          for (const uid of targetUserIds) {
            rowsToInsert.push({
              user_id: uid,
              work_date: dateStr,
              starts_at: hours.starts_at,
              ends_at: hours.ends_at,
              grace_minutes: input.grace_minutes,
            });
          }
        }
      }
      current.setUTCDate(current.getUTCDate() + 1);
    }

    const inserted = await insertWorkSchedulesBatch(db, rowsToInsert);
    await audit(db, actor.id, 'SCHEDULES_GENERATED', actor.id, {
      from: input.from,
      to: input.to,
      users_count: targetUserIds.length,
      generated: inserted,
      skipped_days: skippedDays,
    });

    return {
      total_users: targetUserIds.length,
      generated_schedules: inserted,
      skipped_days: skippedDays,
    };
  });
}
