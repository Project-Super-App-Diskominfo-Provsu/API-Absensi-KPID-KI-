import { z } from 'zod';
export const enrollSchema = z
  .object({
    device_id: z.uuid(),
    nonce: z.string().min(40).max(100),
    signature: z.string().max(200),
    consent_version: z.string().trim().min(1).max(100),
    consent: z.literal('true'),
  })
  .strict();

export const reviewEnrollmentSchema = z
  .object({
    status: z.enum(['ACTIVE', 'REVOKED']),
    identity_verified: z.boolean(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export const deleteFaceSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
