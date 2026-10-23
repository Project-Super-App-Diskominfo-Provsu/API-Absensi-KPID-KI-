import { describe, expect, it } from 'vitest';
import {
  createLeaveSchema,
  leaveQuerySchema,
  reviewLeaveSchema,
} from '../src/modules/leave/leave.schema.js';

describe('leave schema validation', () => {
  it('accepts valid leave request payloads for all categories', () => {
    for (const category of ['SAKIT', 'IZIN', 'CUTI', 'DINAS_LUAR'] as const) {
      const result = createLeaveSchema.safeParse({
        category,
        start_date: '2026-10-26',
        end_date: '2026-10-28',
        notes: 'Permohonan izin karena keperluan keluarga mendesak',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects end_date before start_date', () => {
    const result = createLeaveSchema.safeParse({
      category: 'IZIN',
      start_date: '2026-10-28',
      end_date: '2026-10-26', // before start_date
      notes: 'Permohonan izin keperluan penting',
    });
    expect(result.success).toBe(false);
  });

  it('rejects too short or empty notes', () => {
    const result = createLeaveSchema.safeParse({
      category: 'SAKIT',
      start_date: '2026-10-26',
      end_date: '2026-10-26',
      notes: 'flu', // < 5 characters
    });
    expect(result.success).toBe(false);
  });

  it('validates review status properly', () => {
    expect(
      reviewLeaveSchema.safeParse({ status: 'APPROVED', review_notes: 'Disetujui' }).success,
    ).toBe(true);
    expect(reviewLeaveSchema.safeParse({ status: 'REJECTED' }).success).toBe(true);
    expect(reviewLeaveSchema.safeParse({ status: 'PENDING' }).success).toBe(false);
  });

  it('validates query ranges in leaveQuerySchema', () => {
    expect(leaveQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
    expect(leaveQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).success).toBe(
      false,
    );
  });
});
