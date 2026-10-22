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
});
