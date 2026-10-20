import { z } from 'zod';
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
    password: z.string().min(12).max(128),
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

export const scheduleSchema = z
  .object({
    user_id: z.uuid(),
    work_date: z.iso.date(),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    grace_minutes: z.number().int().min(0).max(120).default(0),
  })
  .strict()
  .refine((v) => Date.parse(v.ends_at) > Date.parse(v.starts_at));

export const scheduleQuerySchema = z.object({ from: z.iso.date(), to: z.iso.date() }).strict();
