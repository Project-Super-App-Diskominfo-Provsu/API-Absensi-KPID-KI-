import { z } from 'zod';

export const createHolidaySchema = z
  .object({
    holiday_date: z.iso.date(),
    name: z.string().trim().min(2).max(200),
    type: z.enum(['NATIONAL_HOLIDAY', 'JOINT_LEAVE']),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const holidayQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must not be after to.');
