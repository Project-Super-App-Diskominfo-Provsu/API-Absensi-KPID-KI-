import { describe, it, expect } from 'vitest';
import {
  attendanceReviewInput,
  attendanceReviewQuery,
} from '../src/modules/attendance/attendance.review.schema.js';
import { attendanceStatus } from '../src/modules/attendance/attendance.service.js';

describe('attendance review contract', () => {
  it('requires explicit identity verification and an audit reason for approval', () => {
    expect(
      attendanceReviewInput.safeParse({ status: 'APPROVED', reason: 'Verified in person' }).success,
    ).toBe(false);
    expect(
      attendanceReviewInput.safeParse({
        status: 'APPROVED',
        reason: 'Verified in person',
        identity_verified: true,
      }).success,
    ).toBe(true);
    expect(
      attendanceReviewInput.safeParse({ status: 'REJECTED', reason: 'Insufficient evidence' })
        .success,
    ).toBe(true);
    expect(
      attendanceReviewInput.safeParse({ status: 'APPROVED', reason: 'ok', identity_verified: true })
        .success,
    ).toBe(false);
    expect(
      attendanceReviewInput.safeParse({ status: 'ACCEPTED', reason: 'Invalid status' }).success,
    ).toBe(false);
  });
  it('bounds queue pagination and accepts only review states', () => {
    expect(attendanceReviewQuery.parse({})).toEqual({ status: 'PENDING', limit: 25, offset: 0 });
    expect(attendanceReviewQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(attendanceReviewQuery.safeParse({ status: 'ACCEPTED' }).success).toBe(false);
  });
  it('classifies punctuality from capture time rather than review time', () => {
    const schedule = {
      starts_at: '2026-10-26T08:00:00+07:00',
      ends_at: '2026-10-26T16:30:00+07:00',
      grace_minutes: 0,
    };
    expect(attendanceStatus('CHECK_IN', new Date(schedule.starts_at), schedule)).toBe('PRESENT');
    expect(attendanceStatus('CHECK_IN', new Date('2026-10-26T08:00:01+07:00'), schedule)).toBe(
      'LATE',
    );
    expect(attendanceStatus('CHECK_OUT', new Date('2026-10-26T16:29:59+07:00'), schedule)).toBe(
      'EARLY_LEAVE',
    );
    expect(attendanceStatus('CHECK_OUT', new Date(schedule.ends_at), schedule)).toBe('ON_TIME');
  });
});
