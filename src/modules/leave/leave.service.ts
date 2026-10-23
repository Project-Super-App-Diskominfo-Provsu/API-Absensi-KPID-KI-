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
  const categoryCode = actor.role === 'SUPER_ADMIN' ? null : actor.employee_category_code;
  return findAdminLeaveRequests(
    pool,
    {
      categoryCode,
      status: query.status,
      from: query.from,
      to: query.to,
      userId: query.user_id,
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
    const existing = await findLeaveRequestById(db, id, true);
    if (!existing.rowCount) {
      fail(404, 'NOT_FOUND', 'Permohonan izin tidak ditemukan.');
    }
    const leave = existing.rows[0]!;
    if (
      actor.role !== 'SUPER_ADMIN' &&
      leave.employee_category_code !== actor.employee_category_code
    ) {
      fail(403, 'FORBIDDEN', 'Permohonan izin di luar kewenangan admin.');
    }
    if (leave.status !== 'PENDING') {
      fail(409, 'LEAVE_ALREADY_REVIEWED', 'Permohonan izin ini sudah ditinjau sebelumnya.');
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
