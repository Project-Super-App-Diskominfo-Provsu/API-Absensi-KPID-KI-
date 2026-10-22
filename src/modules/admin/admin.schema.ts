import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../../shared/security/password.js';
import { pagination } from '../../shared/validation/pagination.js';
const userFieldsSchema = {
  employee_number: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  employee_category_code: z.enum(['KPID', 'KI']),
  role: z.enum(['EMPLOYEE', 'VERIFIER', 'ADMIN', 'SUPER_ADMIN']),
  unit_id: z.uuid().nullable(),
  active: z.boolean(),
};

export const createUserSchema = z
  .object({
    ...userFieldsSchema,
    password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
    role: userFieldsSchema.role.default('EMPLOYEE'),
    unit_id: userFieldsSchema.unit_id.default(null),
    active: userFieldsSchema.active.default(true),
  })
  .strict();

export const updateUserSchema = z
  .object(userFieldsSchema)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);

export const createUnitSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

const jakartaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function workDateInJakarta(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? jakartaDate.format(timestamp) : null;
}

export const scheduleSchema = z
  .object({
    user_id: z.uuid(),
    work_date: z.iso.date(),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    grace_minutes: z.number().int().min(0).max(120).default(0),
  })
  .strict()
  .refine((v) => Date.parse(v.ends_at) > Date.parse(v.starts_at))
  .refine(
    (v) =>
      workDateInJakarta(v.starts_at) === v.work_date &&
      workDateInJakarta(v.ends_at) === v.work_date,
    'Schedule start and end must fall on work_date in Asia/Jakarta.',
  );

export const scheduleQuerySchema = z.object({ from: z.iso.date(), to: z.iso.date() }).strict();

const rangeFields = { from: z.iso.date(), to: z.iso.date() };
export const userListQuerySchema = pagination
  .extend({
    q: z.string().trim().max(100).optional(),
    employee_category_code: z.enum(['KPID', 'KI']).optional(),
    role: userFieldsSchema.role.optional(),
    active: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();
export const adminScheduleQuerySchema = pagination
  .extend({ ...rangeFields, user_id: z.uuid().optional() })
  .strict()
  .refine((v) => v.from <= v.to, 'from must not be after to.');
export const adminAttendanceQuerySchema = pagination
  .extend({
    ...rangeFields,
    user_id: z.uuid().optional(),
    office_id: z.uuid().optional(),
    type: z.enum(['CHECK_IN', 'CHECK_OUT']).optional(),
    status: z.enum(['PRESENT', 'LATE', 'EARLY_LEAVE', 'ON_TIME']).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, 'from must not be after to.');
export const patchScheduleSchema = z
  .object({
    work_date: z.iso.date().optional(),
    starts_at: z.iso.datetime({ offset: true }).optional(),
    ends_at: z.iso.datetime({ offset: true }).optional(),
    grace_minutes: z.number().int().min(0).max(120).optional(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'reason'),
    'At least one schedule field is required.',
  );
