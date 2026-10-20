import { z } from 'zod';
import { validatePublicKey } from '../../shared/security/crypto.js';
export const bindDeviceSchema = z
  .object({
    public_key: z.string().max(500).refine(validatePublicKey),
    platform: z.literal('ANDROID'),
    signature: z.string().max(200),
  })
  .strict();

export const updateDeviceSchema = z
  .object({
    status: z.enum(['ACTIVE', 'REVOKED']),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export const challengeSchema = z
  .object({
    device_id: z.uuid(),
    purpose: z.enum(['CHECK_IN', 'CHECK_OUT', 'ENROLL']),
  })
  .strict();
