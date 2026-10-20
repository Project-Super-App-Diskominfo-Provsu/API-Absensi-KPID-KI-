import { z } from 'zod';
import { pagination } from '../../shared/validation/pagination.js';
const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform(Number)
  .pipe(z.number().finite());

export const attendanceInput = z
  .object({
    latitude: decimal.pipe(z.number().min(-90).max(90)),
    longitude: decimal.pipe(z.number().min(-180).max(180)),
    accuracy_m: decimal.pipe(z.number().positive().max(1000)),
    captured_at: z.iso.datetime({ offset: true }),
    device_id: z.uuid(),
    nonce: z.string().min(40).max(100),
    signature: z.string().min(40).max(200),
    office_id: z.uuid().optional(),
    is_mock: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export const attendanceHistoryQuerySchema = pagination
  .extend({ from: z.iso.date(), to: z.iso.date() })
  .strict();
