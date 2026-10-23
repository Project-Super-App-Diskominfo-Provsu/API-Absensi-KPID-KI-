import { z } from 'zod';
import { pagination } from '../../shared/validation/pagination.js';

export const createLeaveSchema = z
  .object({
    category: z.enum(['SAKIT', 'IZIN', 'CUTI', 'DINAS_LUAR']),
    start_date: z.iso.date(),
    end_date: z.iso.date(),
    notes: z.string().trim().min(5).max(1000),
    attachment_url: z.string().trim().url().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.end_date >= v.start_date, 'end_date must not be before start_date.');

export const leaveQuerySchema = pagination
  .extend({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must not be after to.');

export const adminLeaveQuerySchema = pagination
  .extend({
    user_id: z.uuid().optional(),
    category: z.enum(['SAKIT', 'IZIN', 'CUTI', 'DINAS_LUAR']).optional(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must not be after to.');

export const reviewLeaveSchema = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED']),
    review_notes: z.string().trim().max(500).optional(),
  })
  .strict();
