import { describe, expect, it } from 'vitest';
import { createHolidaySchema, holidayQuerySchema } from '../src/modules/holiday/holiday.schema.js';

describe('holiday schema validation', () => {
  it('accepts valid national holiday and joint leave schemas', () => {
    const holiday = createHolidaySchema.safeParse({
      holiday_date: '2026-08-17',
      name: 'Hari Kemerdekaan RI',
      type: 'NATIONAL_HOLIDAY',
      description: 'HUT RI ke-81',
    });
    expect(holiday.success).toBe(true);

    const jointLeave = createHolidaySchema.safeParse({
      holiday_date: '2026-03-23',
      name: 'Cuti Bersama Idul Fitri',
      type: 'JOINT_LEAVE',
    });
    expect(jointLeave.success).toBe(true);
  });

  it('rejects invalid holiday types and malformed dates', () => {
    expect(
      createHolidaySchema.safeParse({
        holiday_date: 'invalid-date',
        name: 'Libur',
        type: 'NATIONAL_HOLIDAY',
      }).success,
    ).toBe(false);

    expect(
      createHolidaySchema.safeParse({
        holiday_date: '2026-08-17',
        name: 'Libur',
        type: 'WEEKEND', // invalid type
      }).success,
    ).toBe(false);
  });

  it('validates query ranges correctly', () => {
    expect(holidayQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      true,
    );
    expect(holidayQuerySchema.safeParse({ from: '2026-12-31', to: '2026-01-01' }).success).toBe(
      false,
    );
  });
});
