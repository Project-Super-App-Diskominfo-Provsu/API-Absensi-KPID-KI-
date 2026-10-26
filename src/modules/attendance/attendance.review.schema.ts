import { z } from 'zod';
import { pagination } from '../../shared/validation/pagination.js';

export const attendanceReviewQuery = pagination
  .extend({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
    user_id: z.uuid().optional(),
  })
  .strict();

export const attendanceReviewInput = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().min(5).max(500),
    identity_verified: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.status !== 'APPROVED' || v.identity_verified, {
    path: ['identity_verified'],
    message: 'Verifikasi identitas wajib untuk persetujuan absensi.',
  });

const score = z.number().finite().min(0).max(1);
export const attendanceReviewEvidence = z.object({
  schedule: z.object({
    id: z.uuid(),
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime(),
    grace_minutes: z.number().int().min(0).max(120),
  }),
  template_id: z.uuid(),
  location: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy_m: z.number().positive().max(1000),
    captured_at: z.iso.datetime({ offset: true }),
    device_id: z.uuid(),
    office_id: z.uuid(),
    is_mock: z.literal('false'),
  }),
  office: z.record(z.string(), z.unknown()),
  face_score: score,
  liveness_score: score,
  quality_score: score,
  policy: z.object({
    match: score,
    review: score,
    liveness: score,
    quality: score,
    model_version: z.string().min(1),
  }),
});
export type ReviewEvidence = z.infer<typeof attendanceReviewEvidence>;
