import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../../config/env.js';
import { currentUser } from '../auth/auth.middleware.js';
import {
  enrollFace,
  listPendingFaceEnrollments,
  reviewFaceEnrollment,
  deleteUserFaceData,
} from './face.service.js';
import { type FaceEngine } from './face.types.js';

import { enrollSchema, reviewEnrollmentSchema, deleteFaceSchema } from './face.schema.js';

export function createFaceController(pool: Pool, config: Config, engine: FaceEngine) {
  return {
    async enroll(req: Request, res: Response) {
      const input = enrollSchema.parse(req.body);
      const files = req.files as Express.Multer.File[];
      const user = currentUser(req);
      const data = await enrollFace(pool, config, engine, user, input, files);
      res.status(201).json({ data });
    },

    async listEnrollments(req: Request, res: Response) {
      const actor = currentUser(req);
      const data = await listPendingFaceEnrollments(pool, actor);
      res.json({ data });
    },

    async review(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const input = reviewEnrollmentSchema.parse(req.body);
      const actor = currentUser(req);
      await reviewFaceEnrollment(pool, actor, id, input);
      res.status(204).end();
    },

    async deleteFace(req: Request, res: Response) {
      const id = z.uuid().parse(req.params.id);
      const { reason } = deleteFaceSchema.parse(req.body);
      const actor = currentUser(req);
      await deleteUserFaceData(pool, actor, id, reason);
      res.status(204).end();
    },
  };
}
