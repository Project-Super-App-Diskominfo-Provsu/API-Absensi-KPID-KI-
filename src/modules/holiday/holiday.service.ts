import type { Pool } from 'pg';
import { audit } from '../../database/audit.js';
import { transaction } from '../../database/client.js';
import { fail } from '../../shared/errors/api-error.js';
import type { User } from '../auth/auth.model.js';
import {
  findHolidays,
  findHolidayByDate,
  insertHoliday,
  deleteHolidayById,
} from './holiday.model.js';

export async function listHolidays(pool: Pool, from?: string, to?: string) {
  const result = await findHolidays(pool, from, to);
  return result.rows;
}

export async function createHoliday(
  pool: Pool,
  actor: User,
  input: {
    holiday_date: string;
    name: string;
    type: 'NATIONAL_HOLIDAY' | 'JOINT_LEAVE';
    description?: string;
  },
) {
  return transaction(pool, async (db) => {
    const existing = await findHolidayByDate(db, input.holiday_date);
    if (existing.rowCount) {
      fail(409, 'HOLIDAY_EXISTS', 'Hari libur pada tanggal tersebut sudah terdaftar.');
    }
    const created = await insertHoliday(db, input);
    const row = created.rows[0]!;
    await audit(db, actor.id, 'HOLIDAY_CREATED', row.id, {
      date: input.holiday_date,
      name: input.name,
      type: input.type,
    });
    return row;
  });
}

export async function removeHoliday(pool: Pool, actor: User, id: string) {
  return transaction(pool, async (db) => {
    const deleted = await deleteHolidayById(db, id);
    if (!deleted.rowCount) {
      fail(404, 'NOT_FOUND', 'Hari libur tidak ditemukan.');
    }
    const row = deleted.rows[0]!;
    await audit(db, actor.id, 'HOLIDAY_DELETED', row.id, {
      date: row.holiday_date,
      name: row.name,
    });
    return row;
  });
}
