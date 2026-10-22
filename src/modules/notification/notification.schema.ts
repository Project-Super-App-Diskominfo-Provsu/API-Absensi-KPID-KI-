import { z } from 'zod';

export const pushTokenSchema = z
  .object({
    token: z
      .string()
      .min(20)
      .max(4096)
      .regex(/^[A-Za-z0-9:_.-]+$/),
    signature: z.string().min(1).max(200),
  })
  .strict();
