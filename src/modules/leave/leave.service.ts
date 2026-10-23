import type { Pool } from 'pg';
import { audit } from '../../database/audit.js';
import { transaction } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import type { User } from '../auth/auth.model.js';
import {
  type LeaveCategory,
  insertLeaveRequest,
  findOverlappingLeave,
  findLeaveRequestById,
  findLeaveRequestsByUser,
  findAdminLeaveRequests,
  updateLeaveRequestStatus,
  cancelLeaveRequest,
} from './leave.model.js';

export async function submitLeave(
  pool: Pool,
  user: User,
  input: {
    category: LeaveCategory;
    start_date: string;
    end_date: string;
    notes: string;
    attachment_url?: string;
  },
) {
  return transaction(pool, async (db) => {
    const owner = await db.query('SELECT id FROM users WHERE id=$1 AND active FOR UPDATE', [
      user.id,
    ]);
    if (!owner.rowCount) fail(403, 'USER_INACTIVE', 'Akun tidak aktif.');
    const overlapping = await findOverlappingLeave(db, user.id, input.start_date, input.end_date);
    if (overlapping.rowCount) {
      fail(
        409,
        'LEAVE_OVERLAP',
        'Sudah ada permohonan izin/cuti aktif pada rentang tanggal tersebut.',
      );
    }
    const created = await insertLeaveRequest(db, {
      user_id: user.id,
      category: input.category,
      start_date: input.start_date,
      end_date: input.end_date,
      notes: input.notes,
      attachment_url: input.attachment_url,
    });
    const row = created.rows[0]!;
    await audit(db, user.id, 'LEAVE_REQUESTED', row.id, {
      category: input.category,
      start_date: input.start_date,
      end_date: input.end_date,
    });
    return row;
  });
}

export async function listUserLeaves(
  pool: Pool,
  userId: string,
  query: { from?: string; to?: string; status?: string; limit: number; offset: number },
) {
  return findLeaveRequestsByUser(
    pool,
    userId,
    query.from,
    query.to,
    query.status,
    query.limit,
    query.offset,
  );
}

export async function cancelUserLeave(pool: Pool, user: User, id: string) {
  return transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const existing = await findLeaveRequestById(db, id, true);
    if (!existing.rowCount) {
      fail(404, 'NOT_FOUND', 'Permohonan izin tidak ditemukan.');
    }
    const leave = existing.rows[0]!;
    if (leave.user_id !== user.id) {
      fail(403, 'FORBIDDEN', 'Tidak berwenang membatalkan permohonan izin ini.');
    }
    if (leave.status !== 'PENDING') {
      fail(409, 'LEAVE_NOT_PENDING', 'Hanya permohonan berstatus PENDING yang dapat dibatalkan.');
    }
    const cancelled = await cancelLeaveRequest(db, id, user.id);
    const row = cancelled.rows[0]!;
    await audit(db, user.id, 'LEAVE_CANCELLED', row.id, {
      category: row.category,
      start_date: row.start_date,
    });
    return row;
  });
}

export async function adminListLeaves(
  pool: Pool,
  actor: User,
  query: {
    user_id?: string;
    category?: LeaveCategory;
    status?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  },
) {
  if (actor.role !== 'SUPER_ADMIN' && !actor.employee_category_code) {
    fail(403, 'FORBIDDEN', 'Admin belum memiliki kategori kewenangan.');
  }
  const categoryCode = actor.role === 'SUPER_ADMIN' ? null : actor.employee_category_code;
  return findAdminLeaveRequests(
    pool,
    {
      categoryCode,
      status: query.status,
      from: query.from,
      to: query.to,
      userId: query.user_id,
      category: query.category,
    },
    query.limit,
    query.offset,
  );
}

export async function reviewLeave(
  pool: Pool,
  actor: User,
  id: string,
  input: {
    status: 'APPROVED' | 'REJECTED';
    review_notes?: string;
  },
) {
  return transaction(pool, async (db) => {
    const target = (await findLeaveRequestById(db, id)).rows[0];
    if (!target) fail(404, 'NOT_FOUND', 'Permohonan izin tidak ditemukan.');
    if (target.user_id === actor.id) {
      fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Permohonan sendiri harus ditinjau admin lain.');
    }
    // Use the same user-first lock order as attendance and leave submission.
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target.user_id]);
    const existing = await findLeaveRequestById(db, id, true);
    if (!existing.rowCount) {
      fail(404, 'NOT_FOUND', 'Permohonan izin tidak ditemukan.');
    }
    const leave = existing.rows[0]!;
    if (
      actor.role !== 'SUPER_ADMIN' &&
      (!actor.employee_category_code ||
        leave.employee_category_code !== actor.employee_category_code)
    ) {
      fail(403, 'FORBIDDEN', 'Permohonan izin di luar kewenangan admin.');
    }
    if (leave.status !== 'PENDING') {
      fail(409, 'LEAVE_ALREADY_REVIEWED', 'Permohonan izin ini sudah ditinjau sebelumnya.');
    }
    if (input.status === 'APPROVED') {
      const overlap = await db.query(
        `SELECT id FROM leave_requests WHERE user_id=$1 AND id<>$2 AND status='APPROVED'
         AND start_date<=$4::date AND end_date>=$3::date LIMIT 1`,
        [leave.user_id, id, leave.start_date, leave.end_date],
      );
      if (overlap.rowCount)
        fail(409, 'LEAVE_OVERLAP', 'Sudah ada izin disetujui pada tanggal tersebut.');
    }
    if (input.status === 'APPROVED' && leave.category !== 'DINAS_LUAR') {
      const attendance = await db.query(
        `SELECT a.id FROM attendances a JOIN work_schedules s ON s.id=a.schedule_id
         WHERE a.user_id=$1 AND s.work_date BETWEEN $2::date AND $3::date LIMIT 1`,
        [leave.user_id, leave.start_date, leave.end_date],
      );
      if (attendance.rowCount) {
        fail(
          409,
          'LEAVE_ATTENDANCE_CONFLICT',
          'Rentang izin sudah memiliki absensi. Tinjau tanggal izin.',
        );
      }
    }
    const updated = await updateLeaveRequestStatus(
      db,
      id,
      actor.id,
      input.status,
      input.review_notes,
    );
    const row = updated.rows[0]!;
    await audit(db, actor.id, 'LEAVE_REVIEWED', row.id, {
      status: input.status,
      target_user_id: leave.user_id,
      category: leave.category,
      start_date: leave.start_date,
      end_date: leave.end_date,
      review_notes: input.review_notes,
    });
    return row;
  });
}
