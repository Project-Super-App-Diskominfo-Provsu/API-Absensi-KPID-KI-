import { z } from 'zod';
export const ssoStartSchema = z
  .object({ code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

export const ssoExchangeSchema = z
  .object({
    flow_id: z.uuid(),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(4096),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();

export const linkSsoIdentitySchema = z
  .object({
    user_id: z.uuid(),
    subject: z.string().min(1).max(255),
    auth_mode: z.enum(['SSO', 'BOTH']),
    reason: z.string().trim().min(5).max(500),
    issuer: z.url().optional(),
  })
  .strict();

export const listSsoIdentitiesQuerySchema = z.object({ user_id: z.uuid() }).strict();

export const unlinkSsoIdentitySchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
