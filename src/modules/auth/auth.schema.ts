import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../../shared/security/password.js';
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
export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(128),
    new_password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
  })
  .strict();
