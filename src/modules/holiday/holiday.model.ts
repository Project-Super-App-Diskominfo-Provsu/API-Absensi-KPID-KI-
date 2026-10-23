import type { Db } from '../../database/client.js';

export interface Holiday {
  id: string;
  holiday_date: string;
  name: string;
  type: 'NATIONAL_HOLIDAY' | 'JOINT_LEAVE';
  description?: string | null;
  created_at: string;
}

export async function findHolidays(db: Db, from?: string, to?: string) {
  if (from && to) {
    return db.query<Holiday>(
      'SELECT id,holiday_date::text,name,type,description,created_at FROM holidays WHERE holiday_date BETWEEN $1 AND $2 ORDER BY holiday_date',
      [from, to],
    );
  }
  return db.query<Holiday>(
    'SELECT id,holiday_date::text,name,type,description,created_at FROM holidays ORDER BY holiday_date',
  );
}

export async function findHolidayByDate(db: Db, date: string) {
  return db.query<Holiday>(
    'SELECT id,holiday_date::text,name,type,description,created_at FROM holidays WHERE holiday_date=$1',
    [date],
  );
}

export async function insertHoliday(
  db: Db,
  input: {
    holiday_date: string;
    name: string;
    type: 'NATIONAL_HOLIDAY' | 'JOINT_LEAVE';
    description?: string;
  },
) {
  return db.query<Holiday>(
    'INSERT INTO holidays(holiday_date,name,type,description) VALUES($1,$2,$3,$4) RETURNING id,holiday_date::text,name,type,description,created_at',
    [input.holiday_date, input.name, input.type, input.description ?? null],
  );
}

export async function deleteHolidayById(db: Db, id: string) {
  return db.query<Holiday>(
    'DELETE FROM holidays WHERE id=$1 RETURNING id,holiday_date::text,name,type,description,created_at',
    [id],
  );
}
