import { z } from 'zod';
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const reviewListQuerySchema = pagination
  .extend({
    user_id: z.uuid().optional(),
    status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']).optional(),
  })
  .strict();
