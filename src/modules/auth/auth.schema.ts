import { z } from 'zod';
export const loginSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();

export const refreshSchema = z.object({ refresh_token: z.string().min(40).max(100) }).strict();
