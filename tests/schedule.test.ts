import { describe, expect, it } from 'vitest';
import { scheduleSchema } from '../src/modules/admin/admin.schema.js';

const schedule = {
  user_id: '41b2809e-59b4-44fd-adb5-40acb86a66a5',
  work_date: '2035-01-02',
  starts_at: '2035-01-02T08:00:00+07:00',
  ends_at: '2035-01-02T17:00:00+07:00',
};

describe('same-day schedules in Asia/Jakarta', () => {
  it.each([
    { starts_at: schedule.starts_at, ends_at: schedule.ends_at },
    { starts_at: '2035-01-01T17:00:00Z', ends_at: '2035-01-02T16:59:59Z' },
    { starts_at: '2035-01-02T00:00:00+07:00', ends_at: '2035-01-02T23:59:59+07:00' },
  ])('accepts same-day timestamps regardless of their supplied offset: %j', (times) => {
    expect(scheduleSchema.safeParse({ ...schedule, ...times }).success).toBe(true);
  });

  it.each([
    { starts_at: '2035-01-02T22:00:00+07:00', ends_at: '2035-01-03T06:00:00+07:00' },
    { starts_at: schedule.starts_at, ends_at: '2035-01-03T00:00:00+07:00' },
    { starts_at: '2035-01-01T16:59:59Z', ends_at: '2035-01-01T18:00:00Z' },
    { starts_at: '2035-01-02T18:00:00Z', ends_at: '2035-01-02T20:00:00Z' },
    { starts_at: schedule.ends_at, ends_at: schedule.starts_at },
    { starts_at: schedule.starts_at, ends_at: schedule.starts_at },
    { starts_at: 'not-a-date', ends_at: schedule.ends_at },
    { starts_at: '2035-01-02T08:00:00+24:00', ends_at: schedule.ends_at },
  ])('rejects inconsistent dates, ordering and invalid timestamps: %j', (times) => {
    expect(scheduleSchema.safeParse({ ...schedule, ...times }).success).toBe(false);
  });

  it('defaults Monday-Thursday to 08:00-16:30 and Friday to 08:00-17:00 when omitted', () => {
    // 2026-10-26 is Monday
    const mondayResult = scheduleSchema.safeParse({
      user_id: schedule.user_id,
      work_date: '2026-10-26',
    });
    expect(mondayResult.success).toBe(true);
    if (mondayResult.success) {
      expect(mondayResult.data.starts_at).toBe('2026-10-26T08:00:00+07:00');
      expect(mondayResult.data.ends_at).toBe('2026-10-26T16:30:00+07:00');
    }

    // 2026-10-29 is Thursday
    const thursdayResult = scheduleSchema.safeParse({
      user_id: schedule.user_id,
      work_date: '2026-10-29',
    });
    expect(thursdayResult.success).toBe(true);
    if (thursdayResult.success) {
      expect(thursdayResult.data.starts_at).toBe('2026-10-29T08:00:00+07:00');
      expect(thursdayResult.data.ends_at).toBe('2026-10-29T16:30:00+07:00');
    }

    // 2026-10-30 is Friday
    const fridayResult = scheduleSchema.safeParse({
      user_id: schedule.user_id,
      work_date: '2026-10-30',
    });
    expect(fridayResult.success).toBe(true);
    if (fridayResult.success) {
      expect(fridayResult.data.starts_at).toBe('2026-10-30T08:00:00+07:00');
      expect(fridayResult.data.ends_at).toBe('2026-10-30T17:00:00+07:00');
    }

    // 2026-10-25 is Sunday
    const sundayResult = scheduleSchema.safeParse({
      user_id: schedule.user_id,
      work_date: '2026-10-25',
    });
    expect(sundayResult.success).toBe(false);
  });
});
